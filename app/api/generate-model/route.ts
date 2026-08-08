import type { NextRequest } from 'next/server';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

function findJson(text: string): string {
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('Unable to locate JSON payload in OpenAI output.');
  }
  return text.slice(jsonStart, jsonEnd + 1);
}

function validatePlantModel(data: unknown) {
  if (!data || typeof data !== 'object') throw new Error('Invalid plant model');
  const model = data as { type?: unknown; components?: unknown };
  if (typeof model.type !== 'string') throw new Error('Plant model must include a string type');
  if (!Array.isArray(model.components)) throw new Error('Plant model must include a components array');
  return model;
}

function createFallbackPlantModel(prompt: string) {
  const lower = prompt.toLowerCase();
  return {
    type: prompt,
    components: [
      {
        shape: 'cylinder',
        position: [0, 0.55, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: '#6b4a2f',
        radiusTop: 0.08,
        radiusBottom: 0.12,
        height: 1.1,
        radialSegments: 10,
      },
      {
        shape: 'sphere',
        position: [0, 1.25, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: lower.includes('flower') || lower.includes('blossom') ? '#f7ccd6' : '#5a8b3f',
        radius: lower.includes('cactus') ? 0.28 : 0.55,
        radialSegments: 12,
      },
      {
        shape: 'sphere',
        position: [0.35, 1.0, 0],
        rotation: [0, 0, 0],
        scale: [0.7, 0.7, 0.7],
        color: '#84a96b',
        radius: 0.28,
        radialSegments: 10,
      },
    ],
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OPENAI_API_KEY is not configured on the server.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const systemMessage = `You are a procedural 3D plant model generator.
Return ONLY valid JSON, with no markdown, no extra text, and no explanation.
The JSON must be an object with keys:\n- type: string\n- components: array of component objects\nEach component object must include:\n- shape: one of cylinder, cone, sphere, box, torus\n- position: [x, y, z]\n- rotation: [x, y, z]\n- scale: [x, y, z] or number\n- color: a CSS color string like #aabbcc or rgb(...)
Optional numeric properties depend on the shape: radius, radiusTop, radiusBottom, height, width, depth, tube, radialSegments, heightSegments, widthSegments, depthSegments.
Use realistic dimensions for a single plant geometry that will be instanced multiple times in a scene.`;

  const userMessage = `Generate a single plant model for the cue: "${prompt}".
Use natural plant proportions and include enough components to produce a recognizably leafy or floral shape.`;

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.95,
      max_tokens: 600,
    }),
  });

  let result: any;
  try {
    result = await response.json();
  } catch (error) {
    const text = await response.text();
    return new Response(JSON.stringify({ model: createFallbackPlantModel(prompt), warning: 'OpenAI returned a non-JSON response.', details: text || String(error) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!response.ok) {
    return new Response(JSON.stringify({ model: createFallbackPlantModel(prompt), warning: 'OpenAI request failed, using fallback', details: result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const output = Array.isArray(result.choices) && result.choices[0]?.message?.content
    ? result.choices[0].message.content
    : typeof result?.choices?.[0]?.text === 'string'
      ? result.choices[0].text
      : '';

  if (!output) {
    return new Response(JSON.stringify({ error: 'OpenAI returned no usable output.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let modelData: unknown;
  try {
    const payload = findJson(output);
    modelData = JSON.parse(payload);
    validatePlantModel(modelData);
  } catch (err) {
    modelData = createFallbackPlantModel(prompt);
  }

  return new Response(JSON.stringify({ model: modelData }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
