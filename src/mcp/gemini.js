const { GoogleGenerativeAI } = require('@google/generative-ai');

// Ordered by preference. Uses stable model IDs by default.
const MODELS = [
  process.env.GEMINI_MODEL_PRIMARY || 'gemini-2.5-flash',
  process.env.GEMINI_MODEL_FALLBACK_1 || 'gemini-2.0-flash',
  process.env.GEMINI_MODEL_FALLBACK_2 || 'gemini-2.5-pro',
].filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);

let genAI = null;
const MODEL_TIMEOUT_MS = 35000;
const RETRY_ATTEMPTS_PER_MODEL = 2;
const RETRY_DELAY_MS = 1200;
const MODEL_COOLDOWN_MS = 5 * 60 * 1000;
const modelCooldownUntil = new Map();

function getClient() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

function isRetryableError(err) {
  const msg = err.message || '';
  return msg.includes('503') || msg.includes('429') || msg.includes('overloaded') || msg.includes('high demand') || msg.includes('rate');
}

function isOverloadedError(err) {
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('503') || msg.includes('overloaded') || msg.includes('high demand') || msg.includes('resource exhausted');
}

function isUnsupportedModelError(err) {
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('404') || msg.includes('not found') || msg.includes('not supported for generatecontent');
}

function getCandidateModels() {
  const now = Date.now();
  const available = [];
  const coolingDown = [];

  for (const modelName of MODELS) {
    const cooldown = modelCooldownUntil.get(modelName) || 0;
    if (cooldown <= now) {
      available.push(modelName);
    } else {
      coolingDown.push(modelName);
    }
  }

  // Try non-cooled models first, but keep cooled models as last-resort fallbacks.
  return [...available, ...coolingDown];
}

function markModelCooldown(modelName) {
  modelCooldownUntil.set(modelName, Date.now() + MODEL_COOLDOWN_MS);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function askWithMeta(prompt) {
  const client = getClient();
  let lastError;

  for (const modelName of getCandidateModels()) {
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const model = client.getGenerativeModel({ model: modelName });
        const result = await withTimeout(model.generateContent(prompt), MODEL_TIMEOUT_MS);
        const text = result.response.text();
        modelCooldownUntil.delete(modelName);
        return { text, model: modelName, attempts: attempt };
      } catch (err) {
        lastError = err;
        const retryable = isRetryableError(err) || String(err.message || '').includes('timed out');
        const atLastAttemptForModel = attempt >= RETRY_ATTEMPTS_PER_MODEL;

        if (isUnsupportedModelError(err)) {
          console.error(`[AI] ${modelName} unsupported for this API/version, trying next model: ${err.message}`);
          break;
        }

        if (isOverloadedError(err)) {
          markModelCooldown(modelName);
        }

        if (!retryable) {
          throw err;
        }

        if (!atLastAttemptForModel) {
          console.error(`[AI] ${modelName} attempt ${attempt} failed, retrying: ${err.message}`);
          await delay(RETRY_DELAY_MS * attempt);
          continue;
        }

        console.error(`[AI] ${modelName} unavailable after ${attempt} attempt(s), trying next model: ${err.message}`);
      }
    }
  }

  throw lastError;
}

async function ask(prompt) {
  const result = await askWithMeta(prompt);
  return result.text;
}

async function chat(messages, newMessage) {
  const client = getClient();
  let lastError;
  for (const modelName of getCandidateModels()) {
    try {
      const model = client.getGenerativeModel({ model: modelName });
      const session = model.startChat({ history: messages });
      const result = await session.sendMessage(newMessage);
      modelCooldownUntil.delete(modelName);
      return result.response.text();
    } catch (err) {
      lastError = err;
      if (isUnsupportedModelError(err)) {
        console.error(`[AI] ${modelName} unsupported for chat, trying next model: ${err.message}`);
        continue;
      }
      if (isOverloadedError(err)) {
        markModelCooldown(modelName);
      }
      if (isRetryableError(err)) {
        console.error(`[AI] ${modelName} unavailable, trying next model: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

module.exports = { ask, askWithMeta, chat, MODEL_NAME: MODELS[0] };
