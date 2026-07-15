"""Pure-Python implementation of the Sentinel SDK VM for solving turnstile dx challenges."""

import base64
import json
import math
import re
from typing import Any, Dict, List, Optional


def _js_str(val) -> str:
    """JS-style String coercion: arrays join with comma, None->'undefined', etc."""
    if val is None:
        return "undefined"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, list):
        return ",".join(_js_str(v) for v in val)
    if isinstance(val, (int, float)):
        if isinstance(val, float) and val == int(val) and abs(val) < 2**53:
            return str(int(val))
        return str(val)
    return str(val)


def _xor_str(a: str, b: str) -> str:
    if not b:
        return a
    return "".join(chr(ord(a[i]) ^ ord(b[i % len(b)])) for i in range(len(a)))


# Register keys for pre-loaded handlers (from SDK constants)
R_XOR = 1       # Ft
R_SET = 2       # Lt
R_RESOLVE = 3   # Jt
R_REJECT = 4    # Gt
R_PUSH = 5      # Wt
R_ACCESS = 6    # zt
R_CALL = 7      # Vt
R_COPY = 8      # Bt
R_QUEUE = 9     # Zt (instruction queue)
R_WINDOW = 10   # Kt
R_SCRIPT = 11   # Qt
R_VMSTATE = 12  # Yt
R_CATCH = 13    # Xt
R_JPARSE = 14   # tn
R_JSTR = 15     # nn
R_KEY = 16      # en (XOR key)
R_TRY = 17      # rn
R_ATOB = 18     # on
R_BTOA = 19     # cn
R_CONDEQ = 20   # un
R_CONDDIST = 21 # an
R_EXEC = 22     # fn
R_CONDEX = 23   # sn
R_BIND = 24     # Ht
R_NOOP1 = 25    # ln
R_NOOP2 = 26    # dn
R_SPLICE = 27   # hn
R_NOOP3 = 28    # pn
R_CMPLT = 29    # mn
R_DEFFN = 30    # gn
R_MUL = 33      # wn
R_AWAIT = 34    # yn
R_DIV = 35      # vn


class _JSObj(dict):
    """Dict that also supports attribute access, mimicking JS objects."""
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            return None
    def __setattr__(self, name, value):
        self[name] = value
    def __hash__(self):
        return id(self)
    def __str__(self):
        if 'href' in self:
            return self['href']
        return "[object Object]"


def _make_obj(**kw):
    o = _JSObj()
    o.update(kw)
    return o


class _FakeWindow(_JSObj):
    """Browser window mock with realistic API surface for sentinel VM."""

    def __init__(self, user_agent: str = "", sdk_url: str = ""):
        super().__init__()
        import time as _time

        self.navigator = _make_obj(
            userAgent=user_agent,
            language="en-US",
            languages=["en-US", "en"],
            hardwareConcurrency=8,
            platform="MacIntel",
            maxTouchPoints=0,
            cookieEnabled=True,
            webdriver=False,
            vendor="Google Inc.",
            appVersion=user_agent.replace("Mozilla/", "") if user_agent else "",
            product="Gecko",
            productSub="20030107",
            deviceMemory=8,
            connection=_make_obj(effectiveType="4g", rtt=50, downlink=10),
            plugins=_make_obj(length=5),
            mimeTypes=_make_obj(length=2),
            pdfViewerEnabled=True,
        )

        _now_base = _time.time() * 1000
        self.performance = _make_obj(
            timeOrigin=_now_base - 5000,
            now=lambda: _time.time() * 1000 - _now_base + 5000,
            memory=_make_obj(
                jsHeapSizeLimit=4294705152,
                totalJSHeapSize=35000000,
                usedJSHeapSize=25000000,
            ),
        )

        self.location = _make_obj(
            href="https://sentinel.openai.com/backend-api/sentinel/frame.html",
            origin="https://sentinel.openai.com",
            pathname="/backend-api/sentinel/frame.html",
            protocol="https:",
            host="sentinel.openai.com",
            hostname="sentinel.openai.com",
            port="",
        )

        de = _make_obj(getAttribute=lambda name: None)
        body = _make_obj(clientWidth=1920, clientHeight=1080)
        scripts_list = [_make_obj(src=sdk_url)] if sdk_url else []

        def _make_canvas():
            _ctx2d = _make_obj(
                fillStyle="", strokeStyle="", font="10px sans-serif",
                fillRect=lambda *a: None, strokeRect=lambda *a: None,
                clearRect=lambda *a: None, fillText=lambda *a: None,
                strokeText=lambda *a: None, measureText=lambda t: _make_obj(width=len(t)*6.5),
                beginPath=lambda: None, closePath=lambda: None,
                arc=lambda *a: None, fill=lambda *a: None, stroke=lambda *a: None,
                moveTo=lambda *a: None, lineTo=lambda *a: None,
                rect=lambda *a: None, clip=lambda *a: None,
                save=lambda: None, restore=lambda: None,
                translate=lambda *a: None, rotate=lambda *a: None, scale=lambda *a: None,
                setTransform=lambda *a: None,
                createLinearGradient=lambda *a: _make_obj(addColorStop=lambda *a: None),
                createRadialGradient=lambda *a: _make_obj(addColorStop=lambda *a: None),
                drawImage=lambda *a: None,
                getImageData=lambda x, y, w, h: _make_obj(data=[0]*(w*h*4)),
                putImageData=lambda *a: None,
                createImageData=lambda w, h: _make_obj(data=[0]*(w*h*4)),
                canvas=None,
                globalCompositeOperation="source-over",
                globalAlpha=1.0,
                lineWidth=1.0,
                lineCap="butt",
                lineJoin="miter",
                miterLimit=10.0,
                shadowBlur=0, shadowColor="rgba(0, 0, 0, 0)",
                shadowOffsetX=0, shadowOffsetY=0,
                isPointInPath=lambda *a: False,
            )
            _webgl_ext = _make_obj(
                UNMASKED_VENDOR_WEBGL=0x9245,
                UNMASKED_RENDERER_WEBGL=0x9246,
            )
            _webgl = _make_obj(
                getParameter=lambda p: {0x9245: "Google Inc. (Intel)", 0x9246: "ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)", 0x1F01: "WebKit", 0x1F00: "WebKit WebGL", 0x8B8C: 256, 0x0D33: 16384}.get(p, 0),
                getExtension=lambda n: _webgl_ext if "WEBGL" in (n or "") else _make_obj(),
                getSupportedExtensions=lambda: ["WEBGL_debug_renderer_info", "EXT_texture_filter_anisotropic"],
                createBuffer=lambda: _make_obj(),
                bindBuffer=lambda *a: None,
                bufferData=lambda *a: None,
                createProgram=lambda: _make_obj(),
                createShader=lambda *a: _make_obj(),
                shaderSource=lambda *a: None,
                compileShader=lambda *a: None,
                attachShader=lambda *a: None,
                linkProgram=lambda *a: None,
                useProgram=lambda *a: None,
                getShaderParameter=lambda *a: True,
                getProgramParameter=lambda *a: True,
                getAttribLocation=lambda *a: 0,
                getUniformLocation=lambda *a: _make_obj(),
                vertexAttribPointer=lambda *a: None,
                enableVertexAttribArray=lambda *a: None,
                drawArrays=lambda *a: None,
                viewport=lambda *a: None,
                clearColor=lambda *a: None,
                clear=lambda *a: None,
                readPixels=lambda *a: None,
                canvas=None,
                VERTEX_SHADER=0x8B31, FRAGMENT_SHADER=0x8B30,
                ARRAY_BUFFER=0x8892, STATIC_DRAW=0x88E4,
                COMPILE_STATUS=0x8B81, LINK_STATUS=0x8B82,
                FLOAT=0x1406, TRIANGLES=0x0004,
                COLOR_BUFFER_BIT=0x4000, DEPTH_BUFFER_BIT=0x100,
                RENDERER=0x1F01, VENDOR=0x1F00,
                MAX_TEXTURE_SIZE=0x0D33,
                MAX_VERTEX_UNIFORM_VECTORS=0x8DFB,
            )
            def _get_context(ctx_type, *args):
                if ctx_type == "2d":
                    return _ctx2d
                if ctx_type in ("webgl", "experimental-webgl", "webgl2"):
                    return _webgl
                return None
            c = _make_obj(
                width=300, height=150,
                getContext=_get_context,
                toDataURL=lambda *a: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                toBlob=lambda cb, *a: cb(None) if callable(cb) else None,
                style=_make_obj(),
            )
            _ctx2d["canvas"] = c
            _webgl["canvas"] = c
            return c

        self.document = _make_obj(
            documentElement=de,
            scripts=scripts_list,
            body=body,
            hidden=False,
            visibilityState="visible",
            hasFocus=lambda: True,
            createElement=lambda tag: _make_canvas() if tag == "canvas" else _make_obj(
                style=_make_obj(), appendChild=lambda c: None, removeChild=lambda c: None,
                innerHTML="", textContent="",
                getBoundingClientRect=lambda: _make_obj(x=0, y=639.296875, width=150.9453125, height=25, top=639.296875, right=150.9453125, bottom=664.296875, left=0),
            ),
            getElementById=lambda i: None,
            querySelector=lambda s: None,
            querySelectorAll=lambda s: [],
            fonts=_make_obj(check=lambda *a: True, ready=_make_obj(then=lambda fn: fn() if callable(fn) else None)),
            referrer="",
            location=self.location,
        )

        self.screen = _make_obj(
            width=1920, height=1080,
            availWidth=1920, availHeight=1040,
            availLeft=0, availTop=0,
            colorDepth=24, pixelDepth=24,
            orientation=_make_obj(type="landscape-primary", angle=0),
        )

        self.history = _make_obj(length=2)
        class _Storage:
            def __init__(self): self._d = {}
            @property
            def length(self): return len(self._d)
            def getItem(self, k): return self._d.get(k)
            def setItem(self, k, v): self._d[str(k)] = str(v)
            def removeItem(self, k): self._d.pop(k, None)
            def key(self, i): return list(self._d.keys())[i] if i < len(self._d) else None
            def clear(self): self._d.clear()
            def keys(self): return list(self._d.keys())
        self.localStorage = _Storage()
        _ls_keys = [
            'i18nextLng', 'ajs_anonymous_id', 'ajs_user_id',
            'oai/apps/hasSeenOnboarding/chat',
            'oai/apps/hasSeenReleaseAnnouncement/chat',
            'oai/apps/capExposure/chat', 'oai/apps/cachedUser/chat',
            'oai-did', 'oai-sc-ses', 'oai-hlib',
            'intercom.intercom-state', 'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V5',
            'STATSIG_LOCAL_STORAGE_STABLE_ID', 'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST',
            '_dd_s', 'cf_clearance', 'UiState.isNavigationCollapsed.chat',
            'UiState.isSidebarExpanded.chat',
        ]
        for _k in _ls_keys:
            self.localStorage.setItem(_k, 'x')
        self.sessionStorage = _Storage()
        self.indexedDB = _make_obj()
        self.crypto = _make_obj(
            getRandomValues=lambda arr: arr,
            subtle=_make_obj(),
        )

        self.innerWidth = 1920
        self.innerHeight = 1080
        self.outerWidth = 1920
        self.outerHeight = 1120
        self.devicePixelRatio = 1
        self.screenX = 0
        self.screenY = 0
        self.pageXOffset = 0
        self.pageYOffset = 0
        self.parent = self
        self.top = self
        self['self'] = self
        self.frames = self
        self.frameElement = None

        def _reflect_set(obj, key, val):
            try:
                if isinstance(obj, dict):
                    obj[str(key)] = val
                else:
                    setattr(obj, str(key), val)
            except Exception:
                pass
            return True

        def _reflect_get(obj, key):
            try:
                if isinstance(obj, dict):
                    return obj.get(str(key))
                return getattr(obj, str(key), None)
            except Exception:
                return None

        self.Reflect = _make_obj(
            set=_reflect_set,
            get=_reflect_get,
            has=lambda obj, key: (str(key) in obj if isinstance(obj, dict) else hasattr(obj, str(key))) if obj else False,
            ownKeys=lambda obj: list(obj.keys()) if hasattr(obj, 'keys') and callable(obj.keys) else [],
        )
        self.Object = _make_obj(
            create=lambda proto: _make_obj(),
            keys=lambda obj: list(obj.keys()) if hasattr(obj, 'keys') and callable(obj.keys) else [],
            values=lambda obj: list(obj.values()) if hasattr(obj, 'values') and callable(obj.values) else [],
            entries=lambda obj: list(obj.items()) if hasattr(obj, 'items') and callable(obj.items) else [],
            getOwnPropertyDescriptor=lambda obj, key: _make_obj(value=obj.get(key) if isinstance(obj, dict) else getattr(obj, str(key), None), writable=True, enumerable=True, configurable=True),
            defineProperty=lambda obj, key, desc: obj,
            assign=lambda target, *sources: target,
        )
        self.Array = _make_obj(
            isArray=lambda obj: isinstance(obj, list),
            **{"from": lambda obj: list(obj) if obj else []},
        )
        self.Math = _make_obj(
            abs=abs, floor=math.floor, ceil=math.ceil, round=round,
            max=max, min=min, pow=pow, sqrt=math.sqrt,
            log=math.log, sin=math.sin, cos=math.cos, tan=math.tan,
            random=__import__('random').random,
            PI=math.pi, E=math.e,
            imul=lambda a, b: (a * b) & 0xFFFFFFFF,
        )
        self.JSON = _make_obj(
            parse=lambda s: json.loads(s),
            stringify=lambda o, *a: json.dumps(o, separators=(',', ':')),
        )
        self.String = _make_obj(
            fromCharCode=lambda *codes: "".join(chr(c) for c in codes),
        )
        self.Number = _make_obj(
            isFinite=lambda v: isinstance(v, (int, float)) and math.isfinite(v),
            isNaN=lambda v: isinstance(v, float) and math.isnan(v),
            parseInt=lambda s, *a: int(float(s)) if s else 0,
        )
        self.Date = _make_obj(
            now=lambda: int(_time.time() * 1000),
        )
        self.TextEncoder = type("TE", (), {"__call__": lambda self2: _make_obj(encode=lambda s: list(s.encode("utf-8")))})()
        self.Intl = _make_obj(
            DateTimeFormat=lambda *a, **k: _make_obj(resolvedOptions=lambda: _make_obj(timeZone="Asia/Shanghai")),
        )
        self.setTimeout = lambda fn, ms, *a: None
        self.setInterval = lambda fn, ms, *a: None
        self.requestAnimationFrame = lambda fn: None

        self.InstallTrigger = None
        self.solana = None
        self.chrome = _make_obj(runtime=_make_obj())
        self.Atomics = _make_obj()
        self.SharedArrayBuffer = type("SAB", (), {})
        self.WebAssembly = _make_obj()

        def _make_audio_ctx(*a):
            osc = _make_obj(
                type="triangle", frequency=_make_obj(value=10000),
                connect=lambda dest: dest, disconnect=lambda *a: None,
                start=lambda *a: None, stop=lambda *a: None,
            )
            analyser = _make_obj(
                fftSize=2048, frequencyBinCount=1024,
                connect=lambda dest: dest, disconnect=lambda *a: None,
                getFloatFrequencyData=lambda arr: None,
                getByteFrequencyData=lambda arr: None,
            )
            gain = _make_obj(
                gain=_make_obj(value=0, setValueAtTime=lambda *a: None),
                connect=lambda dest: dest, disconnect=lambda *a: None,
            )
            compressor = _make_obj(
                threshold=_make_obj(value=-50), knee=_make_obj(value=40),
                ratio=_make_obj(value=12), attack=_make_obj(value=0),
                release=_make_obj(value=0.25),
                connect=lambda dest: dest, disconnect=lambda *a: None,
            )
            dest = _make_obj()
            ctx = _make_obj(
                sampleRate=44100,
                state="running",
                destination=dest,
                currentTime=0.01,
                createOscillator=lambda: osc,
                createAnalyser=lambda: analyser,
                createGain=lambda: gain,
                createDynamicsCompressor=lambda: compressor,
                createBuffer=lambda ch, sz, sr: _make_obj(
                    getChannelData=lambda c: [0.0]*sz,
                    numberOfChannels=ch, length=sz, sampleRate=sr,
                ),
                createBufferSource=lambda: _make_obj(
                    buffer=None, connect=lambda d: d,
                    start=lambda *a: None, stop=lambda *a: None,
                ),
                createScriptProcessor=lambda *a: _make_obj(
                    connect=lambda d: d, disconnect=lambda *a: None,
                    onaudioprocess=None,
                ),
                close=lambda: None,
                resume=lambda: None,
            )
            return ctx

        self.AudioContext = _make_audio_ctx
        self.webkitAudioContext = _make_audio_ctx
        self.OfflineAudioContext = lambda *a: _make_audio_ctx()
        self.webkitOfflineAudioContext = lambda *a: _make_audio_ctx()

        self.speechSynthesis = _make_obj(
            getVoices=lambda: [
                _make_obj(name="Google US English", lang="en-US", localService=False, default=True, voiceURI="Google US English"),
                _make_obj(name="Google UK English Female", lang="en-GB", localService=False, default=False, voiceURI="Google UK English Female"),
            ],
            speak=lambda u: None,
            cancel=lambda: None,
        )
        self.SpeechSynthesisUtterance = lambda text="": _make_obj(text=text)

        self.matchMedia = lambda q: _make_obj(matches=False, media=q)
        self.getComputedStyle = lambda el, *a: _make_obj()
        self.Notification = _make_obj(permission="default")
        self.caches = _make_obj()
        self.fetch = lambda *a, **k: None
        self.XMLHttpRequest = type("XHR", (), {})
        self.Worker = type("W", (), {})
        self.ServiceWorker = type("SW", (), {})
        self.Proxy = type("P", (), {})
        self.Symbol = _make_obj(
            iterator="Symbol(Symbol.iterator)",
            toPrimitive="Symbol(Symbol.toPrimitive)",
            toStringTag="Symbol(Symbol.toStringTag)",
        )
        self.Blob = type("Blob", (), {})
        self.File = type("File", (), {})
        self.FileReader = type("FR", (), {})
        self.FormData = type("FD", (), {})
        self.URL = _make_obj(createObjectURL=lambda b: "blob:null/fake")
        self.Promise = _make_obj(resolve=lambda v: _make_obj(then=lambda fn: fn(v) if callable(fn) else None))
        self.Map = type("Map", (), {})
        self.Set = type("Set", (), {})
        self.WeakMap = type("WM", (), {})
        self.WeakSet = type("WS", (), {})
        self.Int8Array = type("I8A", (), {})
        self.Uint8Array = type("U8A", (), {})
        self.Float32Array = type("F32A", (), {})
        self.Float64Array = type("F64A", (), {})
        self.ArrayBuffer = type("AB", (), {})
        self.DataView = type("DV", (), {})
        self.ResizeObserver = type("RO", (), {})
        self.IntersectionObserver = type("IO", (), {})
        self.MutationObserver = type("MO", (), {})
        self.PerformanceObserver = type("PO", (), {})
        self.trustedTypes = _make_obj(createPolicy=lambda *a: _make_obj())
        self.ontouchstart = None
        self.onpointerdown = None


class SentinelVM:
    """Execute dx bytecode to produce the turnstile 't' value."""

    def __init__(self, user_agent: str = "", sdk_url: str = ""):
        self.r: Dict[Any, Any] = {}  # registers
        self._win = _FakeWindow(user_agent, sdk_url)
        self._done = False
        self._result: Optional[str] = None
        self._iter = 0
        self._install_handlers()

    def _g(self, k):
        return self.r.get(k)

    def _s(self, k, v):
        self.r[k] = v

    def _install_handlers(self):
        vm = self

        def h_xor(dst, key_r):
            a = _js_str(vm._g(dst)) if vm._g(dst) is not None else ""
            b = _js_str(vm._g(key_r)) if vm._g(key_r) is not None else ""
            vm._s(dst, _xor_str(a, b))

        def h_set(dst, val):
            vm._s(dst, val)

        def h_resolve(val):
            if not vm._done:
                vm._done = True
                vm._result = base64.b64encode(str(val).encode()).decode()

        def h_reject(val):
            if not vm._done:
                vm._done = True
                vm._result = base64.b64encode(str(val).encode()).decode()

        def h_push(dst, src):
            ex = vm._g(dst)
            val = vm._g(src)
            if isinstance(ex, list):
                ex.append(val)
            else:
                vm._s(dst, (_js_str(ex) if ex is not None else "") + (_js_str(val) if val is not None else ""))

        def h_splice(dst, src):
            ex = vm._g(dst)
            val = vm._g(src)
            if isinstance(ex, list):
                try:
                    idx = ex.index(val)
                    ex.pop(idx)
                except (ValueError, IndexError):
                    pass
            else:
                try:
                    vm._s(dst, float(ex or 0) - float(val or 0))
                except (ValueError, TypeError):
                    pass

        def h_access(dst, obj_r, key_r):
            obj = vm._g(obj_r)
            key = vm._g(key_r)
            if obj is None:
                raise TypeError(f"Cannot read properties of undefined (reading '{key}')")
            try:
                if isinstance(obj, (list, tuple)):
                    vm._s(dst, obj[int(key)])
                elif isinstance(obj, str):
                    if isinstance(key, (int, float)):
                        vm._s(dst, obj[int(key)])
                    else:
                        vm._s(dst, getattr(obj, str(key), None))
                elif isinstance(obj, dict):
                    skey = str(key) if not isinstance(key, str) else key
                    vm._s(dst, obj.get(skey, obj.get(key)))
                else:
                    vm._s(dst, getattr(obj, str(key), None))
            except Exception:
                vm._s(dst, None)

        def h_call(fn_r, *arg_regs):
            func = vm._g(fn_r)
            if callable(func):
                args = [vm._g(a) for a in arg_regs]
                try:
                    func(*args)
                except Exception:
                    pass

        def h_copy(dst, src):
            vm._s(dst, vm._g(src))

        def h_script(dst, regex_r):
            pattern = str(vm._g(regex_r) or "")
            result = None
            for s in (vm._win.document.scripts or []):
                src = getattr(s, "src", "") or ""
                m = re.search(pattern, src)
                if m:
                    groups = m.groups()
                    result = (list(groups) if groups else [m.group()])
                    break
            vm._s(dst, result)

        def h_vmstate(dst):
            vm._s(dst, vm.r)

        def h_try(dst, func_r, *arg_regs):
            func = vm._g(func_r)
            args = [vm._g(a) for a in arg_regs]
            try:
                if callable(func):
                    res = func(*args)
                    if res is not None:
                        vm._s(dst, res)
                else:
                    vm._s(dst, None)
            except Exception as e:
                vm._s(dst, str(e))

        def h_catch(dst, func_r, *raw_args):
            func = vm._g(func_r)
            try:
                if callable(func):
                    func(*raw_args)
                else:
                    raise TypeError(f"{type(func).__name__} is not a function")
            except Exception as e:
                ename = type(e).__name__
                vm._s(dst, f"{ename}: {e}" if str(e) else ename)

        def h_jparse(dst, src_r):
            try:
                vm._s(dst, json.loads(str(vm._g(src_r))))
            except Exception:
                vm._s(dst, None)

        def h_jstr(dst, src_r):
            try:
                vm._s(dst, json.dumps(vm._g(src_r), separators=(',', ':')))
            except Exception:
                vm._s(dst, None)

        def h_atob(r):
            try:
                vm._s(r, base64.b64decode(_js_str(vm._g(r))).decode("latin-1"))
            except Exception:
                pass

        def h_btoa(r):
            try:
                s = vm._g(r)
                vm._s(r, base64.b64encode(_js_str(s).encode("latin-1")).decode())
            except Exception:
                pass

        def h_condeq(a_r, b_r, func_r, *extra):
            if vm._g(a_r) == vm._g(b_r):
                func = vm._g(func_r)
                if callable(func):
                    try:
                        func(*extra)
                    except Exception:
                        pass

        def h_conddist(a_r, b_r, thresh_r, func_r, *extra):
            try:
                if abs(float(vm._g(a_r)) - float(vm._g(b_r))) <= float(vm._g(thresh_r)):
                    func = vm._g(func_r)
                    if callable(func):
                        func(*[vm._g(e) for e in extra])
            except (ValueError, TypeError):
                pass

        def h_condex(val_r, func_r, *extra):
            if vm._g(val_r) is not None:
                func = vm._g(func_r)
                if callable(func):
                    try:
                        func(*extra)
                    except Exception:
                        pass

        def h_bind(dst, obj_r, method_r):
            obj = vm._g(obj_r)
            name = vm._g(method_r)
            try:
                vm._s(dst, getattr(obj, str(name)))
            except Exception:
                vm._s(dst, None)

        def h_cmplt(dst, a_r, b_r):
            try:
                vm._s(dst, float(vm._g(a_r)) < float(vm._g(b_r)))
            except (ValueError, TypeError):
                vm._s(dst, False)

        def h_mul(dst, a_r, b_r):
            try:
                vm._s(dst, float(vm._g(a_r)) * float(vm._g(b_r)))
            except (ValueError, TypeError):
                vm._s(dst, 0)

        def h_div(dst, a_r, b_r):
            try:
                b = float(vm._g(b_r))
                vm._s(dst, float(vm._g(a_r)) / b if b else 0)
            except (ValueError, TypeError):
                vm._s(dst, 0)

        def h_await(dst, src_r):
            vm._s(dst, vm._g(src_r))

        def h_exec(dst, new_insts):
            saved = list(vm._g(R_QUEUE) or [])
            insts = list(new_insts) if isinstance(new_insts, list) else []
            vm._s(R_QUEUE, insts)
            try:
                vm._run_queue()
            except Exception as e:
                vm._s(dst, str(e))
            vm._s(R_QUEUE, saved)

        def h_deffn(name_r, ret_r, e=None, r=None):
            has_params = isinstance(r, list)
            param_keys = e if has_params else []
            body_insts = r if has_params else (e if isinstance(e, list) else [])

            def vm_func(*args):
                if vm._done:
                    return
                saved_queue = list(vm._g(R_QUEUE) or [])
                if has_params and isinstance(param_keys, list):
                    for i2, pk in enumerate(param_keys):
                        if i2 < len(args):
                            vm._s(pk, args[i2])
                vm._s(R_QUEUE, list(body_insts))
                vm._run_queue()
                result = vm._g(ret_r)
                vm._s(R_QUEUE, saved_queue)
                return result

            vm._s(name_r, vm_func)

        def h_noop(*_):
            pass

        # Install all handlers in registers
        self._s(R_XOR, h_xor)
        self._s(R_SET, h_set)
        self._s(R_RESOLVE, h_resolve)
        self._s(R_REJECT, h_reject)
        self._s(R_PUSH, h_push)
        self._s(R_ACCESS, h_access)
        self._s(R_CALL, h_call)
        self._s(R_COPY, h_copy)
        self._s(R_WINDOW, self._win)
        self._s(R_SCRIPT, h_script)
        self._s(R_VMSTATE, h_vmstate)
        self._s(R_CATCH, h_catch)
        self._s(R_JPARSE, h_jparse)
        self._s(R_JSTR, h_jstr)
        self._s(R_TRY, h_try)
        self._s(R_ATOB, h_atob)
        self._s(R_BTOA, h_btoa)
        self._s(R_CONDEQ, h_condeq)
        self._s(R_CONDDIST, h_conddist)
        self._s(R_EXEC, h_exec)
        self._s(R_CONDEX, h_condex)
        self._s(R_BIND, h_bind)
        self._s(R_NOOP1, h_noop)
        self._s(R_NOOP2, h_noop)
        self._s(R_SPLICE, h_splice)
        self._s(R_NOOP3, h_noop)
        self._s(R_CMPLT, h_cmplt)
        self._s(R_DEFFN, h_deffn)
        self._s(R_MUL, h_mul)
        self._s(R_AWAIT, h_await)
        self._s(R_DIV, h_div)

    def solve(self, dx_b64: str, xor_key: str) -> str:
        raw = base64.b64decode(dx_b64)
        decrypted = _xor_str(raw.decode("latin-1"), xor_key)
        instructions = json.loads(decrypted)

        self._done = False
        self._result = None
        self._iter = 0
        self._s(R_KEY, xor_key)
        self._s(R_QUEUE, instructions)

        self._run_queue()

        if self._result is not None:
            return self._result
        return str(self._iter)

    def _run_queue(self):
        """Execute instructions by popping from R_QUEUE dynamically."""
        while not self._done:
            queue = self._g(R_QUEUE)
            if not queue or not isinstance(queue, list) or len(queue) == 0:
                break
            inst = queue.pop(0)
            if not isinstance(inst, list) or len(inst) == 0:
                continue
            self._iter += 1
            op = inst[0]
            handler = self._g(op)
            if callable(handler):
                try:
                    handler(*inst[1:])
                except Exception:
                    pass


def solve_turnstile_dx(dx_b64: str, p_token: str, user_agent: str = "", sdk_url: str = "") -> str:
    """Solve a Sentinel turnstile dx challenge.

    Args:
        dx_b64: Base64-encoded dx value from sentinel/req response
        p_token: The 'p' requirements token sent in the sentinel/req request
        user_agent: Browser user agent string
        sdk_url: URL of the sentinel SDK script

    Returns:
        The 't' value for the sentinel token header
    """
    vm = SentinelVM(user_agent=user_agent, sdk_url=sdk_url)
    return vm.solve(dx_b64, p_token)
