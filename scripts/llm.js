/**
 * Unified LLM Client supporting Google Gemini, OpenAI, Anthropic, and OpenRouter.
 * Uses native fetch with exponential backoff, jitter, and automatic model fallback.
 */

try {
  if (process.loadEnvFile) process.loadEnvFile();
} catch (_) {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanJson(rawText) {
  if (typeof rawText !== 'string') return rawText;
  let cleaned = rawText.trim();
  // Strip markdown code fences if present: ```json ... ``` or ``` ... ```
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    // If there is extra leading/trailing text outside JSON, isolate the outer {...}
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1).trim();
    }
  }
  return JSON.parse(cleaned);
}

export async function callLLM({ systemPrompt, userPrompt, temperature = 0.7, jsonMode = true }) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (geminiKey) {
    try {
      return await callGemini({ apiKey: geminiKey, systemPrompt, userPrompt, temperature, jsonMode });
    } catch (geminiErr) {
      console.warn(`[LLM] Gemini provider exhausted all models and retries: ${geminiErr.message}`);
      if (!openrouterKey && !openaiKey && !anthropicKey) {
        throw geminiErr;
      }
      console.log('[LLM] Attempting fallback to alternative LLM provider...');
    }
  }

  if (openrouterKey) {
    try {
      return await callOpenAICompatible({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: openrouterKey,
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
        systemPrompt,
        userPrompt,
        temperature,
        jsonMode,
      });
    } catch (orErr) {
      console.warn(`[LLM] OpenRouter fallback failed: ${orErr.message}`);
      if (!openaiKey && !anthropicKey) throw orErr;
    }
  }

  if (openaiKey) {
    try {
      return await callOpenAICompatible({
        url: 'https://api.openai.com/v1/chat/completions',
        apiKey: openaiKey,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        systemPrompt,
        userPrompt,
        temperature,
        jsonMode,
      });
    } catch (oaErr) {
      console.warn(`[LLM] OpenAI fallback failed: ${oaErr.message}`);
      if (!anthropicKey) throw oaErr;
    }
  }

  if (anthropicKey) {
    return await callAnthropic({ apiKey: anthropicKey, systemPrompt, userPrompt, temperature });
  }

  throw new Error(
    'No LLM API key found in environment or .env file.\nPlease set GEMINI_API_KEY (or OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY).'
  );
}

async function callGemini({ apiKey, systemPrompt, userPrompt, temperature, jsonMode }) {
  const preferredModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  // List of fallback models to cycle through if primary experiences 503 high demand or 429 rate limit
  const candidateModels = Array.from(
    new Set(
      [
        preferredModel,
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.5-flash',
        'gemini-flash-latest',
        'gemini-flash-lite-latest',
        'gemini-pro-latest',
      ].filter(Boolean)
    )
  );

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      temperature,
      responseMimeType: jsonMode ? 'application/json' : 'text/plain',
    },
  };

  const maxAttemptsPerModel = 4;
  let lastError = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) throw new Error(`Gemini (${model}) returned an empty candidate response.`);
          return jsonMode ? cleanJson(text) : text;
        }

        const errText = await res.text();
        lastError = new Error(`Gemini API (${model}) error (${res.status}): ${errText}`);

        // If model is permanently not found/deprecated, don't waste retry loops on it
        if (res.status === 404) {
          console.warn(`[LLM] Model "${model}" is not available (404). Trying next model...`);
          break;
        }

        // Retry on 503 (high demand), 429 (rate limits), or 5xx server issues
        const isRetryableStatus = [429, 500, 502, 503, 504].includes(res.status);
        if (isRetryableStatus && attempt < maxAttemptsPerModel) {
          const waitMs = Math.min(25000, attempt * 3000 + Math.floor(Math.random() * 2000));
          console.warn(
            `[LLM] Gemini (${model}) returned HTTP ${res.status} (High demand / spike). Retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxAttemptsPerModel})...`
          );
          await sleep(waitMs);
          continue;
        }

        if (!isRetryableStatus) {
          // Non-retryable HTTP error (e.g. 400 Bad Request)
          break;
        }
      } catch (fetchErr) {
        lastError = fetchErr;
        if (attempt < maxAttemptsPerModel) {
          const waitMs = Math.min(25000, attempt * 3000 + Math.floor(Math.random() * 2000));
          console.warn(
            `[LLM] Gemini (${model}) network error: ${fetchErr.message}. Retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxAttemptsPerModel})...`
          );
          await sleep(waitMs);
          continue;
        }
      }
    }

    console.warn(`[LLM] Model "${model}" temporarily overloaded or unavailable. Trying next candidate model...`);
  }

  throw lastError || new Error('All Gemini candidate models failed.');
}

async function callOpenAICompatible({ url, apiKey, model, systemPrompt, userPrompt, temperature, jsonMode }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const body = {
    model,
    messages,
    temperature,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('API returned an empty response.');
        return jsonMode ? cleanJson(text) : text;
      }

      const errText = await res.text();
      lastError = new Error(`OpenAI-compatible API error (${res.status}): ${errText}`);

      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < maxAttempts) {
        const waitMs = attempt * 3000 + Math.floor(Math.random() * 1500);
        console.warn(`[LLM] API returned HTTP ${res.status}. Retrying in ${(waitMs / 1000).toFixed(1)}s...`);
        await sleep(waitMs);
        continue;
      }
      break;
    } catch (networkErr) {
      lastError = networkErr;
      if (attempt < maxAttempts) {
        const waitMs = attempt * 3000;
        await sleep(waitMs);
        continue;
      }
    }
  }

  throw lastError;
}

async function callAnthropic({ apiKey, systemPrompt, userPrompt, temperature }) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
  const url = 'https://api.anthropic.com/v1/messages';

  const body = {
    model,
    max_tokens: 4096,
    temperature,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `${userPrompt}\n\nIMPORTANT: Return ONLY a valid JSON object matching the requested schema. No markdown formatting, no code fence blocks.`,
      },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Anthropic returned an empty response.');

  return cleanJson(text);
}
