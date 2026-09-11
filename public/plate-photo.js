(function () {
  "use strict";
  var fileInput = document.querySelector("#booking-form [data-plate-photo]");
  if (!fileInput || fileInput.dataset.ocrBound) return;
  fileInput.dataset.ocrBound = "1";
  var plateInput = document.querySelector("#booking-form [name=plate]");
  var statusEl = document.querySelector("[data-photo-status]");
  var suggEl = document.querySelector("[data-photo-suggestion]");
  var useBtn = document.querySelector("[data-use-photo-plate]");
  var field =
    fileInput.closest(".plate-field") ||
    fileInput.closest("label") ||
    fileInput.parentNode;
  var gen = 0,
    worker = null,
    busy = false,
    objectURL = null;
  var MAXB = 15 * 1024 * 1024,
    INIT_TIMEOUT = 60000,
    REC_TIMEOUT = 60000,
    MAX_MP = 40 * 1e6,
    MAX_PREVIEW = 1000;
  function log(m) {
    if (statusEl) statusEl.textContent = m;
  }
  var panel = document.createElement("div");
  panel.className = "ocr-panel";
  panel.hidden = true;
  panel.innerHTML =
    '<p class="ocr-hint">Dibuje un rect\u00e1ngulo alrededor de la placa con el dedo y pulse Leer recorte.</p>' +
    '<canvas class="ocr-canvas" width="1600" height="900" data-keep></canvas>' +
    '<div class="ocr-ranges">' +
    '<label>X <input type="range" min="0" max="100" value="0" data-crop="x"></label>' +
    '<label>Y <input type="range" min="0" max="100" value="0" data-crop="y"></label>' +
    '<label>Ancho <input type="range" min="1" max="100" value="100" data-crop="w"></label>' +
    '<label>Alto <input type="range" min="1" max="100" value="100" data-crop="h"></label>' +
    "</div>" +
    '<div class="ocr-btns">' +
    '<button type="button" data-act="crop">Leer recorte</button>' +
    '<button type="button" data-act="whole">Leer imagen completa</button>' +
    '<button type="button" data-act="cancel" data-keep>Cancelar</button>' +
    "</div>" +
    '<input type="text" class="ocr-manual" placeholder="Placa detectada (editable)" aria-label="Placa detectada manualmente" data-keep>' +
    '<select class="ocr-candidates" aria-label="Candidatos detectados" hidden></select>';
  field.insertAdjacentElement("afterend", panel);
  var canvas = panel.querySelector("canvas"),
    ctx = canvas.getContext("2d");
  var manual = panel.querySelector(".ocr-manual");
  var candidatesSel = panel.querySelector(".ocr-candidates");
  var img = null,
    imgW = 0,
    imgH = 0;
  var crop = { x: 0, y: 0, w: 100, h: 100 };
  function setBusy(b) {
    busy = b;
    panel.querySelectorAll("button,input,select").forEach(function (el) {
      el.disabled = b && el.getAttribute("data-act") !== "cancel";
    });
    if (useBtn) useBtn.disabled = b;
  }
  function setCrop(k, v) {
    crop[k] = Math.max(k === "w" || k === "h" ? 1 : 0, Math.min(100, v));
    draw();
  }
  panel.querySelectorAll("[data-crop]").forEach(function (r) {
    r.addEventListener("input", function () {
      setCrop(r.dataset.crop, +r.value);
    });
  });
  function draw() {
    if (!img) return;
    var cw = (crop.w / 100) * imgW,
      ch = (crop.h / 100) * imgH,
      cx = (crop.x / 100) * imgW,
      cy = (crop.y / 100) * imgH;
    var scale = Math.min(canvas.width / imgW, canvas.height / imgH);
    var dw = imgW * scale,
      dh = imgH * scale,
      ox = (canvas.width - dw) / 2,
      oy = (canvas.height - dh) / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, ox, oy, dw, dh);
    ctx.strokeStyle = "#0af";
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + cx * scale, oy + cy * scale, cw * scale, ch * scale);
  }
  var drag = null;
  function pos(e) {
    var r = canvas.getBoundingClientRect();
    var t = e.touches ? e.touches[0] : e;
    return {
      x: ((t.clientX - r.left) * canvas.width) / r.width,
      y: ((t.clientY - r.top) * canvas.height) / r.height,
    };
  }
  function applyDrag(p) {
    if (!drag || !img) return;
    var scale = Math.min(canvas.width / imgW, canvas.height / imgH);
    var dw = imgW * scale,
      dh = imgH * scale,
      ox = (canvas.width - dw) / 2,
      oy = (canvas.height - dh) / 2;
    var x0 = Math.min(drag.x, p.x),
      x1 = Math.max(drag.x, p.x),
      y0 = Math.min(drag.y, p.y),
      y1 = Math.max(drag.y, p.y);
    x0 = Math.max(ox, Math.min(ox + dw, x0));
    x1 = Math.max(ox, Math.min(ox + dw, x1));
    y0 = Math.max(oy, Math.min(oy + dh, y0));
    y1 = Math.max(oy, Math.min(oy + dh, y1));
    crop.x = Math.round(((x0 - ox) / dw) * 100);
    crop.y = Math.round(((y0 - oy) / dh) * 100);
    crop.w = Math.max(1, Math.round(((x1 - x0) / dw) * 100));
    crop.h = Math.max(1, Math.round(((y1 - y0) / dh) * 100));
    syncRanges();
    draw();
  }
  function syncRanges() {
    panel.querySelectorAll("[data-crop]").forEach(function (r) {
      r.value = crop[r.dataset.crop];
    });
  }
  canvas.addEventListener("pointerdown", function (e) {
    if (busy || !img) return;
    canvas.setPointerCapture(e.pointerId);
    drag = pos(e);
  });
  canvas.addEventListener("pointermove", function (e) {
    if (drag) applyDrag(pos(e));
  });
  canvas.addEventListener("pointerup", function () {
    drag = null;
  });
  canvas.addEventListener("pointercancel", function () {
    drag = null;
  });
  function uniq(c) {
    return Array.from(new Set(c));
  }
  var PLATE_RE = /^[A-Z][A-Z0-9]{1,2}[0-9]{3,4}$/;
  function validPlate(v) {
    return typeof v === "string" && v.length === 6 && PLATE_RE.test(v);
  }
  function normalize(v) {
    return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function extractCandidates(text) {
    var cands = [];
    var lines = text.split(/\n+/);
    lines.forEach(function (line) {
      var up = line.toUpperCase().replace(/[^A-Z0-9 \-]/g, " ");
      var parts = up.split(/[ \-]+/).filter(Boolean);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (validPlate(p)) cands.push(p);
        if (i + 1 < parts.length) {
          var a = parts[i],
            b = parts[i + 1];
          if (/^[A-Z][A-Z0-9]{1,2}$/.test(a) && /^[0-9]{3,4}$/.test(b)) {
            var j = a + b;
            if (validPlate(j)) cands.push(j);
          }
        }
      }
    });
    return uniq(cands).slice(0, 5);
  }
  function renderCandidates(c) {
    if (candidatesSel) {
      candidatesSel.innerHTML = "";
      if (!c.length) {
        candidatesSel.hidden = true;
      } else {
        candidatesSel.hidden = false;
        c.forEach(function (v) {
          var o = document.createElement("option");
          o.value = v;
          o.textContent = v;
          candidatesSel.appendChild(o);
        });
        candidatesSel.value = c[0];
      }
    }
    if (!c.length) {
      if (suggEl) suggEl.textContent = "Sin candidatos. Edite manualmente.";
      manual.value = "";
      return;
    }
    if (suggEl) suggEl.textContent = "Candidatos: " + c.join(", ");
    manual.value = c[0];
    if (c.length > 1)
      manual.setAttribute(
        "aria-label",
        "Candidato seleccionado (top 5): " + c.join(", "),
      );
    else manual.setAttribute("aria-label", "Placa detectada (editable)");
  }
  if (candidatesSel) {
    candidatesSel.addEventListener("change", function () {
      if (candidatesSel.value) manual.value = candidatesSel.value;
    });
  }
  manual.addEventListener("input", function () {
    manual.value = manual.value.toUpperCase();
  });
  if (useBtn) {
    useBtn.hidden = true;
    useBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        if (busy) return;
        var v = normalize(manual.value);
        if (!v) {
          log("Escriba una placa v\u00e1lida.");
          return;
        }
        if (!validPlate(v)) {
          log("Placa inv\u00e1lida. Use formato ABC123 o AB1234.");
          return;
        }
        manual.value = v;
        if (plateInput) {
          plateInput.value = v;
          plateInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        var lk = document.querySelector("[data-lookup-plate]");
        if (lk) lk.click();
      },
      { capture: true },
    );
  }
  function terminateWorker() {
    if (worker) {
      var w = worker;
      worker = null;
      try {
        var p = w.terminate();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {}
    }
  }
  function cancelRun() {
    gen++;
    terminateWorker();
    setBusy(false);
    manual.value = "";
    if (candidatesSel) {
      candidatesSel.innerHTML = "";
      candidatesSel.hidden = true;
    }
    if (suggEl) {
      suggEl.textContent = "";
      suggEl.hidden = true;
    }
    if (useBtn) useBtn.hidden = true;
    log("Cancelado.");
  }
  panel.querySelector("[data-act=cancel]").addEventListener("click", cancelRun);
  function loadImage(file, token) {
    return new Promise(function (res, rej) {
      if (!file) return rej(new Error("sin archivo"));
      if (!/^image\//.test(file.type))
        return rej(new Error("Formato no soportado"));
      if (file.size > MAXB) return rej(new Error("Imagen mayor a 15MB"));
      var url = URL.createObjectURL(file);
      var im = new Image();
      function cleanup() {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      }
      im.onload = function () {
        if (token !== gen) {
          cleanup();
          rej(new Error("stale"));
          return;
        }
        if (im.width * im.height > MAX_MP) {
          cleanup();
          rej(new Error("Imagen demasiado grande"));
          return;
        }
        var scaleP = Math.min(1, MAX_PREVIEW / Math.max(im.width, im.height));
        var pw = Math.max(1, Math.round(im.width * scaleP)),
          ph = Math.max(1, Math.round(im.height * scaleP));
        var preview = document.createElement("canvas");
        preview.width = pw;
        preview.height = ph;
        preview.getContext("2d").drawImage(im, 0, 0, pw, ph);
        cleanup();
        if (token !== gen) {
          rej(new Error("stale"));
          return;
        }
        img = im;
        imgW = im.naturalWidth || im.width;
        imgH = im.naturalHeight || im.height;
        canvas.width = pw;
        canvas.height = ph;
        crop = { x: 0, y: 0, w: 100, h: 100 };
        syncRanges();
        draw();
        res();
      };
      im.onerror = function () {
        cleanup();
        rej(new Error("No se pudo decodificar imagen"));
      };
      im.src = url;
    });
  }
  function preprocess(mode, gray) {
    var c = document.createElement("canvas");
    var W = Math.max(1, imgW || 1),
      H = Math.max(1, imgH || 1);
    var sx, sy, sw, sh;
    if (mode === "crop") {
      sx = Math.max(0, Math.min(W - 1, (crop.x / 100) * W));
      sy = Math.max(0, Math.min(H - 1, (crop.y / 100) * H));
      sw = Math.max(1, Math.min(W - sx, (crop.w / 100) * W));
      sh = Math.max(1, Math.min(H - sy, (crop.h / 100) * H));
    } else {
      sx = 0;
      sy = 0;
      sw = W;
      sh = H;
    }
    var max = mode === "crop" ? 1800 : 1600;
    var sc = Math.min(mode === "crop" ? 3 : 1, max / Math.max(sw, sh));
    if (sc <= 0) sc = 1;
    c.width = Math.max(1, Math.round(sw * sc));
    c.height = Math.max(1, Math.round(sh * sc));
    var x = c.getContext("2d");
    x.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (gray) {
      var d = x.getImageData(0, 0, c.width, c.height),
        p = d.data;
      for (var i = 0; i < p.length; i += 4) {
        var g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
        var v = Math.max(0, Math.min(255, (g - 128) * 1.5 + 128));
        p[i] = p[i + 1] = p[i + 2] = v;
      }
      x.putImageData(d, 0, 0);
    }
    return c;
  }
  function initWorker(token) {
    return new Promise(function (res, rej) {
      if (typeof window.Tesseract === "undefined")
        return rej(new Error("Tesseract no disponible"));
      var p;
      try {
        p = window.Tesseract.createWorker("eng", 1, {
          errorHandler: function () {},
          langPath:
            "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int",
          logger: function (m) {
            if (token !== gen) return;
            if (m && m.status === "recognizing text")
              log(
                "Reconociendo " +
                  (m.progress ? Math.round(m.progress * 100) + "%" : ""),
              );
          },
        });
      } catch (e) {
        return rej(e);
      }
      if (!p || typeof p.then !== "function")
        return rej(new Error("createWorker no devolvi\u00f3 promesa"));
      var done = false;
      var to = setTimeout(function () {
        if (done) return;
        done = true;
        rej(new Error("Tiempo de espera agotado"));
      }, INIT_TIMEOUT);
      p.then(function (wk) {
        if (done) {
          try {
            wk.terminate();
          } catch (e) {}
          return;
        }
        if (token !== gen) {
          try {
            wk.terminate();
          } catch (e) {}
          done = true;
          clearTimeout(to);
          rej(new Error("stale"));
          return;
        }
        done = true;
        clearTimeout(to);
        res(wk);
      }).catch(function (e) {
        if (done) return;
        done = true;
        clearTimeout(to);
        rej(e);
      });
    });
  }
  function makeAmbiguousAlternatives(v) {
    const out = [];
    if (typeof v !== "string" || v.length !== 6) return out;
    if (typeof validPlate !== "function") return out;

    const map = { O: "0", 0: "O", I: "1", 1: "I" };
    const first = v[0];
    const suffix = v.slice(3);
    const p1 = v[1];
    const p2 = v[2];

    if (map[p1]) {
      const alt = first + map[p1] + p2 + suffix;
      if (alt !== v && !out.includes(alt) && validPlate(alt)) out.push(alt);
    }
    if (map[p2]) {
      const alt = first + p1 + map[p2] + suffix;
      if (alt !== v && !out.includes(alt) && validPlate(alt)) out.push(alt);
    }

    return out.filter((a) => a !== v);
  }

  function scoreResults(list) {
    var map = {};
    list.forEach(function (r) {
      if (!r) return;
      var conf = typeof r.confidence === "number" ? r.confidence : 0;
      var text = r.text || "";
      extractCandidates(text).forEach(function (v) {
        if (!map[v] || map[v] < conf) map[v] = conf;
        var alts = makeAmbiguousAlternatives(v);
        if (alts && alts.length) {
          var altConf = conf - 20;
          alts.forEach(function (a) {
            if (a && a !== v && (!map[a] || map[a] < altConf)) map[a] = altConf;
          });
        }
      });
    });
    return Object.keys(map)
      .sort(function (a, b) {
        return map[b] - map[a];
      })
      .slice(0, 5);
  }
  async function recognize(mode) {
    const token = ++gen;
    let wk, timer;
    setBusy(true);
    manual.value = "";
    candidatesSel.innerHTML = "";
    candidatesSel.hidden = true;
    suggEl.hidden = true;
    useBtn.hidden = true;
    try {
      const results = await Promise.race([
        (async () => {
          wk = await initWorker(token);
          if (token !== gen) {
            await wk.terminate();
            throw Error("stale");
          }
          worker = wk;
          const results = [];
          for (const gray of [false, true]) {
            if (token !== gen) throw Error("stale");
            await wk.setParameters({
              tessedit_pageseg_mode:
                mode === "crop" ? (gray ? "6" : "7") : "11",
              tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -",
            });
            if (token !== gen) throw Error("stale");
            const r = await wk.recognize(preprocess(mode, gray));
            if (token !== gen) throw Error("stale");
            results.push(r.data);
          }
          return results;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("timeout")), 120000);
        }),
      ]);
      if (token !== gen) return;
      const c = scoreResults(results);
      renderCandidates(c);
      suggEl.hidden = !c.length;
      log(
        c.length
          ? "Revisa la placa detectada: " + c[0]
          : "No se detectó una placa. Selecciona un recorte o escribe la placa.",
      );
    } catch {
      if (token === gen) {
        manual.value = "";
        log(
          "No se pudo leer la foto. Selecciona un recorte o escribe la placa.",
        );
      }
    } finally {
      clearTimeout(timer);
      if (token === gen) {
        gen++;
        setBusy(false);
        useBtn.hidden = false;
      }
      if (worker === wk) worker = null;
      if (wk) await wk.terminate().catch(() => {});
    }
  }
  panel.querySelector("[data-act=crop]").addEventListener("click", function () {
    if (!img || busy) return;
    recognize("crop");
  });
  panel
    .querySelector("[data-act=whole]")
    .addEventListener("click", function () {
      if (!img || busy) return;
      recognize("whole");
    });
  fileInput.addEventListener("change", function () {
    var f = fileInput.files && fileInput.files[0];
    var myGen = ++gen;
    terminateWorker();
    setBusy(false);
    if (manual) manual.value = "";
    if (useBtn) useBtn.hidden = true;
    if (objectURL) {
      try {
        URL.revokeObjectURL(objectURL);
      } catch (e) {}
      objectURL = null;
    }
    if (statusEl) statusEl.textContent = "";
    if (suggEl) {
      suggEl.textContent = "";
      suggEl.hidden = true;
    }
    img = null;
    panel.hidden = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!f) return;
    log("Cargando imagen...");
    setBusy(true);
    loadImage(f, myGen)
      .then(function () {
        if (myGen !== gen) return;
        setBusy(false);
        panel.hidden = false;
        log("Imagen lista. Lectura automática...");
        recognize("whole");
      })
      .catch(function () {
        if (myGen !== gen) return;
        setBusy(false);
        img = null;
        panel.hidden = true;
        if (manual) manual.value = "";
        if (useBtn) useBtn.hidden = true;
        if (suggEl) {
          suggEl.textContent = "";
          suggEl.hidden = true;
        }
        log(
          "No se pudo cargar la imagen. Puede escribir la placa manualmente.",
        );
      });
  });
})();
