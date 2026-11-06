// JARVIS lights: the control_lights tool the local model can call, and the
// call to the backend's /v1/lights that carries it out. run() resolves to a
// sentence ready to speak, whether the lights changed or not.
(function () {
  'use strict';

  const TOOL = {
    type: 'function',
    function: {
      name: 'control_lights',
      description: "Control the user's Govee LED lights: turn on or off, set brightness, colour or white " +
        "temperature. Lights: 'office' (office roof lights, the default), 'pc' (PC lights), 'tv' " +
        "(living room TV), or 'all'.",
      parameters: {
        type: 'object',
        properties: {
          light: { type: 'string', description: 'office, pc, tv or all. Default office.' },
          action: { type: 'string', enum: ['on', 'off', 'brightness', 'color', 'temperature'] },
          brightness: { type: 'integer', description: '1-100, for action brightness' },
          color: { type: 'string', description: 'colour name or #hex, for action color' },
          kelvin: { type: 'integer', description: '2000 (warm) to 9000 (cool), for action temperature' },
        },
        required: ['action'],
      },
    },
  };

  function parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }

  async function run(api, rawArgs) {
    const a = parseArgs(rawArgs);
    const body = {
      light: String(a.light || ''),
      action: String(a.action || 'on'),
      brightness: Number.isFinite(+a.brightness) && a.brightness !== '' && a.brightness != null ? Math.round(+a.brightness) : null,
      color: String(a.color || a.colour || ''),
      kelvin: Number.isFinite(+a.kelvin) && a.kelvin != null ? Math.round(+a.kelvin) : null,
    };
    try {
      const r = await fetch(api + '/v1/lights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j.message || 'Done, sir.';
      const d = j.detail;
      return typeof d === 'string' ? d : "The lights didn't take that, sir.";
    } catch {
      return "I couldn't reach the lights, sir.";
    }
  }

  // Collects streamed tool_call deltas (OpenAI shape) into whole calls.
  function collector() {
    const calls = [];
    return {
      add(deltas) {
        for (const d of deltas || []) {
          const i = d.index ?? calls.length;
          const c = (calls[i] = calls[i] || { name: '', args: '' });
          if (d.function?.name) c.name = d.function.name;
          const args = d.function?.arguments;
          if (args != null) c.args += typeof args === 'string' ? args : JSON.stringify(args);
        }
      },
      lights() { return calls.filter((c) => c && c.name === 'control_lights'); },
    };
  }

  window.JarvisLights = { TOOL, run, collector };
})();
