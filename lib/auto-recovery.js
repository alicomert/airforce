// Auto-recovery: upstream tamamen bos / bozuk payload donerse proxy'nin
// kullaniciya asla "empty response" mesaji gostermemesini saglar. Yerine:
//
//   1) history'i analiz edip deterministik bir tool_use sentezle
//      (intent-synthesis.js'deki mevcut synthesizer'i kullanir)
//   2) sentez imkansizsa GORUNMEZ bir "Proceeding" text + end_turn dondur
//      - client (OpenCode/Claude Code) turn'u bitirir, kullanici bir sonraki
//        prompt'u yazabilir
//      - kullanici "empty response / model degistir" stringini BIR DAHA
//        gormez
//
// Dil-agnostik, OS-agnostik, istemci-agnostik: sadece yapisal sinyaller.
// Kapatmak icin: AUTO_RECOVERY=0

import crypto from 'node:crypto';
import process from 'node:process';

import { synthesizeToolCallsFromIntent } from './intent-synthesis.js';

export const AUTO_RECOVERY_ENABLED = process.env.AUTO_RECOVERY !== '0';

// Kullaniciya gosterilecek "sessiz ilerleme" text'i. 'empty response',
// 'try a different model' gibi ifadeler ICERMEZ. Asil amaci: session'i
// canlı tutmak, client'a 'turn bitti, devam et' sinyali vermek.
//
// Neden bos string degil: Anthropic/OpenAI streaming endpoint'leri bazi
// durumlarda tamamen bos content'i reject ediyor; minimal bir nokta gibi
// karakter isini gorur ve UI'da gozle gorulecek kadar dikkat cekmez.
export const SILENT_PROGRESS_TEXT = '.';

function makeToolId() {
  return `toolu_${crypto.randomUUID().replace(/-/g, '')}`;
}

// Son mesaj bir tool hata sonucu mu? (server.js'deki ile ayni mantik,
// auto-recovery'nin kendi dependency'si olmamasi icin burada da var)
function lastToolResultIsError(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const ERROR_PATTERNS = [
    /\bfile not found\b/i,
    /\bno such file\b/i,
    /\bpermission denied\b/i,
    /\bnot found:/i,
    /\benoent\b/i,
    /\bEPERM\b/,
    /\berror:/i,
    /\bfailed:/i,
    /\bcannot (?:read|write|access|find|open)\b/i
  ];
  const looksLikeError = (text) => {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length < 4 || trimmed.length > 2000) return false;
    return ERROR_PATTERNS.some((re) => re.test(trimmed));
  };
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : '');
      return looksLikeError(content);
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResultBlocks = msg.content.filter((b) => b?.type === 'tool_result');
      if (toolResultBlocks.length === 0) continue;
      if (toolResultBlocks.some((b) => b.is_error === true)) return true;
      for (const block of toolResultBlocks) {
        const text = typeof block.content === 'string'
          ? block.content
          : (Array.isArray(block.content) ? block.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n') : '');
        if (looksLikeError(text)) return true;
      }
      return false;
    }
    if (msg.role === 'assistant') return false;
  }
  return false;
}

// Empty/no-progress payload geldiginde proxy'nin kullaniciya ne dondurecegini
// deterministik hesaplar. Iki yol:
//
//   (A) history uygun -> tool_use sentezle (Read/Write/Glob); Anthropic icin
//       content: [tool_use, ...] + stop_reason: 'tool_use' doner. OpenAI Chat
//       icin tool_calls array + finish_reason: 'tool_calls'.
//   (B) sentez imkansiz -> SILENT_PROGRESS_TEXT ile minimal text + end_turn
//       doner. Kullanici 'empty response' mesaji GORMEZ.
//
// Input:
//   - pathname: '/anthropic/v1/messages' veya '*/chat/completions'
//   - requestBody: upstream'e gonderilen (normalize edilmis) request
//   - existingPayload: normalize sonrasi (hala empty/no-progress) upstream cevap
//     (corumak icin: id, model, usage vs. alanlari kaybolmamasi icin)
//
// Returns: yeni payload (aynı sekilde normalize edilmiş, client'a gonderilecek)
export function buildAutoRecoveryPayload(pathname, requestBody, existingPayload) {
  if (!AUTO_RECOVERY_ENABLED) {
    // AUTO_RECOVERY=0 -> mevcut davranis (empty fallback text)
    return null;
  }

  // Tool hatasi sonrasi upstream cevap uretemiyor. Tool sentezi de yanlis
  // dosyayi secebilir (ayni hatayi yeniden tetikler). En guvenli yol:
  // sessiz text doner -> client retry eder veya kullaniciya sorar.
  const skipToolSynthesis = lastToolResultIsError(requestBody);

  let synthesizedToolCalls = [];
  if (!skipToolSynthesis) {
    try {
      synthesizedToolCalls = synthesizeToolCallsFromIntent('', requestBody, [], null) || [];
    } catch {
      synthesizedToolCalls = [];
    }
  }

  const base = (existingPayload && typeof existingPayload === 'object') ? existingPayload : {};

  if (pathname.includes('/anthropic/') || pathname === '/v1/messages') {
    if (synthesizedToolCalls.length > 0) {
      return {
        ...base,
        content: synthesizedToolCalls.map((tc) => ({
          type: 'tool_use',
          id: tc.id ?? makeToolId(),
          name: tc.name,
          input: tc.input ?? {}
        })),
        stop_reason: 'tool_use'
      };
    }
    return {
      ...base,
      content: [{ type: 'text', text: SILENT_PROGRESS_TEXT }],
      stop_reason: base.stop_reason && base.stop_reason !== 'tool_use' ? base.stop_reason : 'end_turn'
    };
  }

  if (pathname.endsWith('/chat/completions')) {
    const firstChoice = Array.isArray(base.choices) && base.choices[0] ? base.choices[0] : {};
    if (synthesizedToolCalls.length > 0) {
      return {
        ...base,
        choices: [{
          ...firstChoice,
          index: firstChoice.index ?? 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: synthesizedToolCalls.map((tc, idx) => ({
              id: `call_${tc.id ?? makeToolId()}`,
              type: 'function',
              index: idx,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input ?? {})
              }
            }))
          }
        }]
      };
    }
    return {
      ...base,
      choices: [{
        ...firstChoice,
        index: firstChoice.index ?? 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: SILENT_PROGRESS_TEXT
        }
      }]
    };
  }

  // OpenAI Responses API (/responses) - cok az kullaniliyor ama kapsayalim
  if (pathname.endsWith('/responses')) {
    if (synthesizedToolCalls.length > 0) {
      return {
        ...base,
        output: [
          {
            id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            content: []
          },
          ...synthesizedToolCalls.map((tc) => ({
            id: `fc_${tc.id ?? makeToolId()}`,
            type: 'function_call',
            call_id: tc.id ?? makeToolId(),
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
            status: 'completed'
          }))
        ]
      };
    }
    return {
      ...base,
      output: [{
        id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: SILENT_PROGRESS_TEXT, annotations: [] }]
      }]
    };
  }

  return null;
}
