const fetch = globalThis.fetch ?? require('node-fetch');
(async () => {
  try {
    const res = await fetch('http://localhost:3000/api/generate-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'cherry blossom tree' }),
    });
    const text = await res.text();
    console.log('status', res.status, res.statusText);
    console.log('body', text);
  } catch (err) {
    console.error('error', err);
  }
})();
