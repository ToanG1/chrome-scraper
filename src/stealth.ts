export const STEALTH_JS = `(function () {
  // WebGL vendor/renderer
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Open Source Technology Center';
    if (p === 37446) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x9A49), Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return getParam.apply(this, arguments);
  };

  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  if (!window.chrome) window.chrome = { runtime: {} };
})();`;
