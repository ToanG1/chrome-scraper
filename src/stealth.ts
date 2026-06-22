export const STEALTH_JS = `(function () {

  // ── WebGL fingerprint ───────────────────────────────────────────────────────
  // Without --ignore-gpu-blocklist + --use-gl=swiftshader, getContext('webgl')
  // returns null entirely and our patch never runs.  With those Chrome flags the
  // context exists (software-rendered) and we override the renderer string to a
  // real laptop GPU so the canvas fingerprint matches a physical machine.
  const GPU_VENDOR   = 'Intel Inc.';
  const GPU_RENDERER = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x9A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = origGetContext.apply(this, [type, ...args]);
    if (!ctx) return ctx;
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      const orig = ctx.getParameter.bind(ctx);
      ctx.getParameter = function (p) {
        if (p === 37445) return GPU_VENDOR;    // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return GPU_RENDERER;  // UNMASKED_RENDERER_WEBGL
        return orig(p);
      };
    }
    return ctx;
  };

  // ── Canvas fingerprint noise ────────────────────────────────────────────────
  // Fingerprinting scripts draw to a small hidden canvas then call toDataURL().
  // We XOR 1 bit in the first few pixels (imperceptible), restore afterwards.
  // Only applied to small canvases — large ones are page content, not probes.
  function addCanvasNoise(canvas) {
    if (canvas.width <= 0 || canvas.height <= 0) return;
    if (canvas.width > 500 || canvas.height > 500) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < Math.min(d.length, 40); i += 4) d[i] ^= 1;
    ctx.putImageData(img, 0, 0);
    return function restore() {
      for (let i = 0; i < Math.min(d.length, 40); i += 4) d[i] ^= 1;
      ctx.putImageData(img, 0, 0);
    };
  }

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
    const restore = addCanvasNoise(this);
    const result  = origToDataURL.apply(this, [type, quality]);
    if (restore) restore();
    return result;
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  if (origToBlob) {
    HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
      const restore = addCanvasNoise(this);
      origToBlob.apply(this, [function (blob) {
        if (restore) restore();
        cb(blob);
      }, type, quality]);
    };
  }

  // ── Navigator properties ────────────────────────────────────────────────────
  Object.defineProperty(navigator, 'webdriver',           { get: () => undefined });
  // Japanese user agent language — matches --lang=ja Chrome flag
  Object.defineProperty(navigator, 'languages',           { get: () => ['ja-JP', 'ja', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });

  // Real Chrome always has PDF Viewer plugin — empty plugins array is an instant bot flag
  try {
    const pdf = { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 0 };
    Object.defineProperty(navigator, 'plugins', {
      get: () => Object.assign([pdf, pdf, pdf], { __proto__: PluginArray.prototype }),
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => Object.assign([], { __proto__: MimeTypeArray.prototype }),
    });
  } catch (e) {}

  // ── permissions.query ───────────────────────────────────────────────────────
  // CDP-attached Chrome reports notifications as 'denied'; real Chrome reports
  // 'default' (user hasn't been asked yet).
  try {
    const origQuery = window.Permissions?.prototype?.query;
    if (origQuery) {
      window.Permissions.prototype.query = function (params) {
        if (params?.name === 'notifications') {
          return Promise.resolve(
            Object.setPrototypeOf({ state: 'default', onchange: null }, PermissionStatus.prototype)
          );
        }
        return origQuery.apply(this, arguments);
      };
    }
  } catch (e) {}

  // ── window.chrome ───────────────────────────────────────────────────────────
  // CDP-attached Chrome has a minimal window.chrome; real Chrome has a rich one.
  // Fingerprinting scripts check chrome.loadTimes, chrome.csi, chrome.app, etc.
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: {
          OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        },
        loadTimes: function () {
          return {
            requestTime: performance.timeOrigin / 1000,
            startLoadTime: performance.timeOrigin / 1000,
            commitLoadTime: (performance.timeOrigin + 50) / 1000,
            finishDocumentLoadTime: (performance.timeOrigin + 300) / 1000,
            finishLoadTime: (performance.timeOrigin + 500) / 1000,
            firstPaintTime: (performance.timeOrigin + 150) / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2',
          };
        },
        csi: function () {
          return {
            startE: performance.timeOrigin,
            onloadT: performance.timeOrigin + 500,
            pageT: performance.now(),
            tran: 15,
          };
        },
      },
      writable: true,
    });
  }

})();`;
