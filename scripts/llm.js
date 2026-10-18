/**
 * Unified LLM Client supporting Google Gemini, OpenAI, Anthropic, and OpenRouter.
 * Uses native fetch (no external dependencies required).
 */

try {
  if (process.loadEnvFile) process.loadEnvFile();
} catch (_) {}

export async function callLLM({ systemPrompt, userPrompt, temperature = 0.7, jsonMode = true }) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (geminiKey) {
    return await callGemini({ apiKey: geminiKey, systemPrompt, userPrompt, temperature, jsonMode });
  }

  if (openrouterKey) {
    return await callOpenAICompatible({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openrouterKey,
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      systemPrompt,
      userPrompt,
      temperature,
      jsonMode,
    });
  }

  if (openaiKey) {
    return await callOpenAICompatible({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      systemPrompt,
      userPrompt,
      temperature,
      jsonMode,
    });
  }

  if (anthropicKey) {
    return await callAnthropic({ apiKey: anthropicKey, systemPrompt, userPrompt, temperature });
  }

  throw new Error(
    'No LLM API key found in environment or .env file.\nPlease set GEMINI_API_KEY (or OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY).'
  );
}

async function callGemini({ apiKey, systemPrompt, userPrompt, temperature, jsonMode }) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response.');

  return jsonMode ? JSON.parse(text) : text;
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI-compatible API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('API returned an empty response.');

  return jsonMode ? JSON.parse(text) : text;
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

  const cleaned = text.replace(/```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}
