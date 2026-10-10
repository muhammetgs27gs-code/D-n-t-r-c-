/* ==========================================================================
   ScanMagic — app.js
   --------------------------------------------------------------------------
   İçindekiler
     0. Sabitler ve durum (state)
     1. Yardımcılar (DOM, canvas, toast, yükleme katmanı)
     2. ADIM 1 — Dosya yükleme: sürükle-bırak, PDF.js ile sayfa render
     3. ADIM 2 — Tarayıcı efekt motoru (Canvas API)
          2.1 Eğrilik   2.2 Gri + eşik   2.3 Gren   2.4 DPI + Gaussian blur   2.5 Cilt gölgesi
     4. Efekt hattı (pipeline): asenkron, UI'ı kilitlemez
     5. ADIM 3 — Dışa aktarma: PDF (pdf-lib), JPG, OCR (Tesseract.js)
     6. Kontroller ve olay bağlama
   ========================================================================== */
'use strict';

/* ==========================================================================
   0. SABİTLER VE DURUM
   ========================================================================== */

/* Çalışma tuvalinin genişliği: A4 (8.27 inç) × 200 DPI ≈ 1654 piksel.
   Tüm efektler bu çözünürlükte uygulanır; "tarama kalitesi" kaydırıcısı
   bunu sonradan düşürerek eski tarayıcı çözünürlüğünü taklit eder. */
const WORK_W = 1654;
const WORK_DPI = 200;
const MAX_H = 3600;                 // çok uzun görseller için bellek koruması
const MAX_FILE_MB = 30;             // bundan büyük dosyaları reddet
const A4_PT = { w: 595.28, h: 841.89 }; // A4, PDF noktası (1/72 inç) cinsinden

/* Kaydırıcıların varsayılan değerleri ("Varsayılanlar" düğmesi bunları geri yükler) */
const DEFAULTS = { threshold: 150, noise: 5, blur: 1, dpi: 150, shadowSide: 'left', shadowStrength: 30 };

/* Kaydırıcı değerlerinin ekranda nasıl yazılacağı */
const FORMAT = {
  threshold: v => v,
  noise: v => v + '%',
  blur: v => Number(v).toFixed(1) + ' px',
  dpi: v => v + ' DPI',
  shadowStrength: v => v + '%'
};

/* Uygulamanın tüm değişken durumu tek yerde tutulur */
const state = {
  sourceCanvas: null,   // temiz (orijinal) belge — efektlerin girdisi
  resultCanvas: null,   // efekt uygulanmış belge — dışa aktarılan çıktı
  baseName: 'belge',    // indirilen dosya adlarının kökü
  pdfDoc: null,         // çok sayfalı PDF'lerde pdf.js belge nesnesi
  view: 'scanned',      // önizlemede gösterilen: 'scanned' | 'original'
  params: { ...DEFAULTS },
  /* Rastgelelik "tohumlanır": kaydırıcı oynarken eğrilik açısı ve gren deseni
     titremesin diye bir kez üretilir, sadece "Yenile" düğmesinde değişir. */
  rand: { angleUnit: 0, seed: 1 },
  runId: 0              // eski (iptal edilmiş) işlemleri tanımak için sayaç
};

/* ==========================================================================
   1. YARDIMCILAR
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* Yeni canvas üretir. willReadFrequently: getImageData/putImageData çok
   kullanılacağı için tarayıcıya CPU tarafında tutmasını söyler (daha hızlı). */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true });
  return c;
}

/* UI'ın boyanmasına fırsat verir. Ağır aşamalar arasında çağrılır;
   böylece spinner dönmeye devam eder ve sayfa donmaz. */
const yieldUI = () => new Promise(r => setTimeout(r, 20));

/* Kısa bildirim gösterir */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* "Processing..." yükleme katmanı. progress (0..1) verilirse ilerleme çubuğu görünür. */
function showLoader(text, progress = null) {
  const l = $('#loader');
  l.classList.remove('hidden'); l.classList.add('flex');
  $('#loaderText').textContent = text;
  const wrap = $('#loaderBarWrap');
  if (progress === null) { wrap.classList.add('hidden'); }
  else { wrap.classList.remove('hidden'); $('#loaderBar').style.width = Math.round(progress * 100) + '%'; }
}
function hideLoader() {
  const l = $('#loader');
  l.classList.add('hidden'); l.classList.remove('flex');
}

/* Tohumlu rastgele sayı üreteci (mulberry32).
   Math.random() yerine bunu kullanırız ki aynı tohumla aynı gren deseni çıksın. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Yeni rastgele eğrilik (-1..+1 birim) ve gren tohumu üretir */
function rollRandom() {
  state.rand.angleUnit = Math.random() * 2 - 1;
  state.rand.seed = (Math.random() * 4294967296) >>> 0;
}

/* ==========================================================================
   2. ADIM 1 — DOSYA YÜKLEME
   ========================================================================== */

/* Herhangi bir çizilebilir kaynağı (Image/Canvas) çalışma genişliğine
   oranını koruyarak sığdırır ve beyaz zemin üzerine çizer. */
function fitToWorkCanvas(src, srcW, srcH) {
  const scale = Math.min(WORK_W / srcW, MAX_H / srcH);
  const c = makeCanvas(Math.round(srcW * scale), Math.round(srcH * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';                       // şeffaf PNG'ler siyah görünmesin
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/* JPG/PNG dosyasını Image olarak yükleyip çalışma canvas'ına aktarır */
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = fitToWorkCanvas(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Görsel okunamadı.')); };
    img.src = url;
  });
}

/* PDF.js ile PDF'in belirtilen sayfasını (varsayılan: ilk sayfa) Canvas'a render eder */
async function renderPdfPage(pdf, pageNo = 1) {
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });          // PDF'in doğal boyutu
  const viewport = page.getViewport({ scale: WORK_W / base.width }); // çalışma genişliğine ölçekle
  const c = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // PDF şeffaf olabilir
  await page.render({ canvasContext: ctx, viewport }).promise;
  return c;
}

/* Seçilen dosyayı doğrular, türüne göre okur ve efekt hattını başlatır */
async function handleFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImg = /^image\/(jpeg|png)$/.test(file.type);
  if (!isPdf && !isImg) return toast('Yalnızca PDF, JPG veya PNG yükleyebilirsin.');
  if (file.size > MAX_FILE_MB * 1024 * 1024) return toast(`Dosya ${MAX_FILE_MB} MB'tan büyük olamaz.`);

  showLoader('Dosya okunuyor…');
  try {
    await yieldUI();
    state.baseName = file.name.replace(/\.[^.]+$/, '') || 'belge';
    state.pdfDoc = null;

    if (isPdf) {
      if (!window.pdfjsLib) throw new Error('PDF kütüphanesi yüklenemedi (internet bağlantısını kontrol et).');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const data = new Uint8Array(await file.arrayBuffer());
      state.pdfDoc = await pdfjsLib.getDocument({ data }).promise;
      state.sourceCanvas = await renderPdfPage(state.pdfDoc, 1); // spec: ilk sayfa
    } else {
      state.sourceCanvas = await loadImageFile(file);
    }

    setupPageSelector();
    $('#studio').classList.remove('hidden');
    rollRandom();
    await runPipeline();
    $('#studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    hideLoader();
    toast(err.message || 'Dosya işlenemedi.');
  }
}

/* Çok sayfalı PDF'lerde sayfa numarası alanını gösterir */
function setupPageSelector() {
  const row = $('#pageRow');
  if (state.pdfDoc && state.pdfDoc.numPages > 1) {
    $('#pageNo').max = state.pdfDoc.numPages;
    $('#pageNo').value = 1;
    $('#pageTotal').textContent = '/ ' + state.pdfDoc.numPages;
    row.classList.remove('hidden'); row.classList.add('flex');
  } else {
    row.classList.add('hidden'); row.classList.remove('flex');
  }
}

/* Sürükle-bırak olayları */
function bindDropzone() {
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-dragover'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  /* Dosya alanının dışına bırakılırsa tarayıcı dosyayı açmasın */
  ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));

  [$('#fileInput'), $('#cameraInput')].forEach(inp => {
    inp.addEventListener('change', () => {
      if (inp.files[0]) handleFile(inp.files[0]);
      inp.value = ''; // aynı dosyayı tekrar seçebilmek için sıfırla
    });
  });
}

/* ==========================================================================
   3. ADIM 2 — TARAYICI EFEKT MOTORU (CANVAS API)
   Her aşama "saf" bir fonksiyondur: bir canvas alır, değiştirir/üretir.
   ========================================================================== */

/* ---- 2.1 EĞRİLİK (Skew & Rotation) --------------------------------------
   Kâğıt tarayıcıya hafif eğik konmuş gibi görünsün diye belgeyi merkez
   etrafında -1.5°..+1.5° arasında döndürür. Dönüşten açılan köşeler beyaz kalır. */
function stageSkew(src, angleDeg) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);         // dönüş merkezini tuvalin ortasına taşı
  ctx.rotate(angleDeg * Math.PI / 180);             // dereceyi radyana çevirip döndür
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -src.width / 2, -src.height / 2); // görseli merkeze göre çiz
  return c;
}

/* ---- 2.2 GRİ TONLAMA + EŞİKLEME (Grayscale & Threshold) -------------------
   1) Her piksel parlaklığa çevrilir (ITU-R BT.601: 0.299R + 0.587G + 0.114B).
   2) "Yumuşak eşik": eşiğin altı siyaha, üstü beyaza gider; ancak eşik çevresindeki
      dar bir bantta (±ramp) değerler doğrusal geçiş yapar. Böylece harflerin kenarları
      tırtıklı olmaz (gerçek tarayıcı çıktısına daha yakın).
   Performans için 256 girişli bir arama tablosu (LUT) kullanılır. */
function stageThreshold(canvas, threshold, ramp = 40) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  const lo = threshold - ramp, hi = threshold + ramp;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = i <= lo ? 0 : i >= hi ? 255 : ((i - lo) / (hi - lo)) * 255;
  }

  for (let p = 0; p < d.length; p += 4) {
    const gray = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
    const v = lut[gray];
    d[p] = d[p + 1] = d[p + 2] = v;                 // R=G=B → gri tonlamalı çıktı
  }
  ctx.putImageData(img, 0, 0);
}

/* ---- 2.3 GREN / GÜRÜLTÜ (Noise & Grain) ---------------------------------
   Piksellerin %percent kadarına rastgele siyah ve koyu gri benek serper
   (kirli tarayıcı camı simülasyonu). Seçilen her benek %35 olasılıkla sağ ve
   alt komşusuna da yayılır; böylece sonraki bulanıklaştırmada tamamen kaybolmaz. */
function stageNoise(canvas, percent, seed) {
  if (percent <= 0) return;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rnd = mulberry32(seed);
  const total = w * h;
  const count = Math.floor(total * percent / 100);

  const paint = (i, v) => { const k = i * 4; d[k] = d[k + 1] = d[k + 2] = v; };

  for (let n = 0; n < count; n++) {
    const i = (rnd() * total) | 0;                  // rastgele piksel indeksi
    const v = rnd() < 0.5 ? 0 : 40 + ((rnd() * 50) | 0); // ya simsiyah ya da koyu gri (40–90)
    paint(i, v);
    if (rnd() < 0.35 && (i % w) < w - 1) paint(i + 1, v);     // sağ komşu
    if (rnd() < 0.35 && i + w < total) paint(i + w, v);       // alt komşu
  }
  ctx.putImageData(img, 0, 0);
}

/* ---- 2.4 DPI DÜŞÜRME + GAUSSIAN BLUR ------------------------------------
   Mükemmel dijital keskinliği bozmak için:
   a) Görüntü hedef DPI'ya küçültülüp tekrar büyütülür (eski tarayıcı çözünürlüğü).
   b) Hafif Gaussian blur uygulanır.
   Blur için ctx.filter yerine kendi algoritmamızı yazdık: iOS Safari ctx.filter
   desteklemez. Gaussian, 3 ardışık "kutu bulanıklığı" (box blur) ile çok yakın
   biçimde taklit edilir ve her piksel için sabit sürede çalışır. */

function stageDpiDowngrade(canvas, dpi) {
  const scale = dpi / WORK_DPI;
  if (scale >= 0.999) return;                        // 200 DPI = değişiklik yok
  const w = canvas.width, h = canvas.height;
  const small = makeCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, small.width, small.height);   // küçült
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, w, h);                          // geri büyüt
}

/* Verilen sigma için n adet kutu genişliği hesaplar (Gaussian ≈ n kutu bulanıklığı) */
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/* Yatay kutu bulanıklığı: her satırda kayan pencere toplamı (kenarlar uzatılır) */
function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let i = 0; i < h; i++) {
    let ti = i * w, li = ti, ri = ti + r;
    const fv = src[ti], lv = src[ti + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j];
    for (let j = 0; j <= r; j++) { val += src[ri++] - fv; dst[ti++] = Math.round(val * iarr); }
    for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = Math.round(val * iarr); }
    for (let j = w - r; j < w; j++) { val += lv - src[li++]; dst[ti++] = Math.round(val * iarr); }
  }
}

/* Dikey kutu bulanıklığı: aynı mantık, sütunlar üzerinde (adım = w) */
function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let i = 0; i < w; i++) {
    let ti = i, li = ti, ri = ti + r * w;
    const fv = src[ti], lv = src[ti + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j * w];
    for (let j = 0; j <= r; j++) { val += src[ri] - fv; dst[ti] = Math.round(val * iarr); ri += w; ti += w; }
    for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = Math.round(val * iarr); li += w; ri += w; ti += w; }
    for (let j = h - r; j < h; j++) { val += lv - src[li]; dst[ti] = Math.round(val * iarr); li += w; ti += w; }
  }
}

/* Görüntü zaten gri tonlamalı (R=G=B) olduğundan yalnızca tek kanalı bulanıklaştırıp
   üç kanala geri yazarız — 3 kat hız kazancı. */
function stageBlur(canvas, sigma) {
  if (sigma <= 0) return;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  let a = new Uint8ClampedArray(w * h);
  let b = new Uint8ClampedArray(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4];       // tek kanalı ayıkla

  for (const size of boxesForGauss(sigma, 3)) {              // 3 geçiş ≈ Gaussian
    const r = (size - 1) / 2;
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  for (let i = 0; i < a.length; i++) { const k = i * 4; d[k] = d[k + 1] = d[k + 2] = a[i]; }
  ctx.putImageData(img, 0, 0);
}

/* ---- 2.5 CİLT GÖLGESİ (Shadow Overlay) ----------------------------------
   Belgenin sol veya sağ kenarına, düşük opaklıkta siyahtan şeffafa giden dikey bir
   doğrusal gradyan ekler (kitap sırtı / ciltleme gölgesi). */
function stageShadow(canvas, side, strengthPercent) {
  if (side === 'none' || strengthPercent <= 0) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const sw = w * 0.14;                                        // gölge genişliği: sayfanın %14'ü
  const a = strengthPercent / 100;
  const x0 = side === 'left' ? 0 : w;                         // gradyanın koyu ucu (kenar)
  const x1 = side === 'left' ? sw : w - sw;                   // gradyanın şeffaf ucu (içeri doğru)
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(0.35, `rgba(0,0,0,${a * 0.35})`);            // yumuşak sönümleme
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(side === 'left' ? 0 : w - sw, 0, sw, h);
}

/* ==========================================================================
   4. EFEKT HATTI (PIPELINE) — ASENKRON
   Aşamalar sırayla çalışır; aralarında yieldUI() ile tarayıcıya nefes aldırılır.
   Yeni bir çalıştırma başlarsa (runId değişirse) eski çalıştırma kendini sonlandırır.
   NOT: Daha da ağır yük için aynı fonksiyonlar bir Web Worker'a taşınabilir
   (ImageData.data.buffer "transferable" olarak gönderilir).
   ========================================================================== */
async function runPipeline() {
  if (!state.sourceCanvas) return;
  const id = ++state.runId;
  const stale = () => id !== state.runId;
  const p = state.params;

  showLoader('Tarayıcı efekti uygulanıyor…');
  try {
    await yieldUI();
    let c = stageSkew(state.sourceCanvas, state.rand.angleUnit * 1.5);      // 1) eğrilik ±1.5°
    if (stale()) return; await yieldUI();

    stageThreshold(c, p.threshold);                                         // 2) gri + eşik
    if (stale()) return; await yieldUI();

    stageNoise(c, p.noise, state.rand.seed);                                // 3) gren
    if (stale()) return; await yieldUI();

    stageDpiDowngrade(c, p.dpi);                                            // 4a) DPI düşür
    stageBlur(c, p.blur);                                                   // 4b) Gaussian blur
    if (stale()) return; await yieldUI();

    stageShadow(c, p.shadowSide, p.shadowStrength);                         // 5) cilt gölgesi

    state.resultCanvas = c;
    drawPreview();
  } catch (err) {
    console.error(err);
    toast('Efekt uygulanırken hata oluştu.');
  } finally {
    if (!stale()) hideLoader(); // yalnızca en güncel çalıştırma katmanı kapatır
  }
}

/* Seçili görünüme (taranmış / orijinal) göre önizleme canvas'ını çizer */
function drawPreview() {
  const src = state.view === 'original' ? state.sourceCanvas : state.resultCanvas;
  if (!src) return;
  const pv = $('#preview');
  pv.width = src.width; pv.height = src.height;     // CSS ile küçülür (max-w-full), çözünürlük korunur
  pv.getContext('2d').drawImage(src, 0, 0);
  $$('.view-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === state.view));
}

/* Kaydırıcı hareketlerinde her pikselde yeniden hesap yapmamak için gecikmeli çalıştır */
let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(runPipeline, 300);
}

/* ==========================================================================
   5. ADIM 3 — DIŞA AKTARMA (CONVERTER ENGINE)
   ========================================================================== */

/* Blob'u kaydeder.
   - Tarayıcıda: gizli <a download> ile indirir.
   - Capacitor (Android) içinde: <a download> WebView'de güvenilir değildir; bu yüzden
     @capacitor/filesystem ile önbelleğe yazıp @capacitor/share ile paylaşım/kaydet
     penceresini açar. (Kurulum: npm i @capacitor/filesystem @capacitor/share && npx cap sync) */
async function saveBlob(blob, filename) {
  const cap = window.Capacitor;
  const plugins = cap && cap.Plugins;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && plugins && plugins.Filesystem) {
    const base64 = await blobToBase64(blob);
    const res = await plugins.Filesystem.writeFile({ path: filename, data: base64, directory: 'CACHE' });
    if (plugins.Share) await plugins.Share.share({ title: filename, url: res.uri });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]); // "data:...;base64," önekini at
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Görüntü oluşturulamadı.')), type, quality));
}

/* Dışa aktarma düğmelerini ortak bir sarmalayıcıyla çalıştırır:
   efekt hazır mı kontrol eder, hataları yakalar, yükleme katmanını yönetir. */
async function runExport(label, fn) {
  if (!state.resultCanvas) return toast('Önce bir belge yükle.');
  showLoader(label);
  try { await yieldUI(); await fn(); }
  catch (err) { console.error(err); toast(err.message || 'İşlem başarısız.'); }
  finally { hideLoader(); }
}

/* a) PDF — pdf-lib ile A4 sayfaya göm.
   Canvas önce JPEG'e çevrilir (PNG'ye göre çok daha küçük PDF), sonra sayfaya
   oranı bozmadan ortalanarak yerleştirilir. */
function exportPdf() {
  return runExport('PDF oluşturuluyor…', async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    const page = doc.addPage([A4_PT.w, A4_PT.h]);

    const jpgBlob = await canvasToBlob(state.resultCanvas, 'image/jpeg', 0.85);
    const img = await doc.embedJpg(new Uint8Array(await jpgBlob.arrayBuffer()));

    const s = Math.min(A4_PT.w / img.width, A4_PT.h / img.height); // sayfaya sığdır (contain)
    const dw = img.width * s, dh = img.height * s;
    page.drawImage(img, { x: (A4_PT.w - dw) / 2, y: (A4_PT.h - dh) / 2, width: dw, height: dh });

    const bytes = await doc.save();
    await saveBlob(new Blob([bytes], { type: 'application/pdf' }), state.baseName + '_scan.pdf');
    toast('PDF hazır ✓');
  });
}

/* b) JPG — toDataURL('image/jpeg', 0.8) ile */
function exportJpg() {
  return runExport('JPG hazırlanıyor…', async () => {
    const dataUrl = state.resultCanvas.toDataURL('image/jpeg', 0.8);
    await saveBlob(dataUrlToBlob(dataUrl), state.baseName + '_scan.jpg');
    toast('JPG hazır ✓');
  });
}

/* c) OCR — Tesseract.js ile metin tanıma, TXT olarak indir.
   Dil verisi (tur + eng) ilk kullanımda internetten indirilir ve önbelleğe alınır.
   Gren ve eğrilik OCR doğruluğunu düşürür; kullanıcı isterse orijinal görüntü kullanılır. */
function exportOcr() {
  return runExport('Metin okunuyor…', async () => {
    if (!window.Tesseract) throw new Error('OCR kütüphanesi yüklenemedi (internet bağlantısını kontrol et).');
    const input = $('#ocrOriginal').checked ? state.sourceCanvas : state.resultCanvas;

    const { data } = await Tesseract.recognize(input, 'tur+eng', {
      logger: m => {                                  // ilerleme bildirimi
        if (m.status === 'recognizing text') showLoader('Metin okunuyor…', m.progress);
        else showLoader('OCR hazırlanıyor (dil verisi yükleniyor)…');
      }
    });

    const text = (data.text || '').trim();
    if (!text) return toast('Görüntüde okunabilir metin bulunamadı.');
    /* BOM (\ufeff): Windows Not Defteri'nin Türkçe karakterleri doğru göstermesi için */
    await saveBlob(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }), state.baseName + '_ocr.txt');
    toast('Metin dosyası hazır ✓');
  });
}

/* ==========================================================================
   6. KONTROLLER VE OLAY BAĞLAMA
   ========================================================================== */

/* [data-param] özniteliği olan her kontrolü state.params ile eşler */
function bindControls() {
  $$('[data-param]').forEach(el => {
    const key = el.dataset.param;
    const sync = () => {
      state.params[key] = el.type === 'range' ? parseFloat(el.value) : el.value;
      const out = $(`[data-out="${key}"]`);
      if (out) out.textContent = (FORMAT[key] || (v => v))(state.params[key]);
    };
    el.addEventListener('input', () => { sync(); scheduleRender(); });
    el.sync = sync;
    sync();
  });

  /* Orijinal / Taranmış geçişi */
  $$('.view-btn').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; drawPreview(); }));

  /* Eğriliği ve grenı yeniden rastgele üret */
  $('#rerollBtn').addEventListener('click', () => { rollRandom(); runPipeline(); });

  /* Varsayılan değerleri geri yükle */
  $('#resetBtn').addEventListener('click', () => {
    $$('[data-param]').forEach(el => { el.value = DEFAULTS[el.dataset.param]; el.sync(); });
    runPipeline();
  });

  /* PDF sayfa seçimi */
  $('#pageNo').addEventListener('change', async e => {
    if (!state.pdfDoc) return;
    const n = Math.min(Math.max(1, parseInt(e.target.value, 10) || 1), state.pdfDoc.numPages);
    e.target.value = n;
    showLoader('Sayfa yükleniyor…');
    try { state.sourceCanvas = await renderPdfPage(state.pdfDoc, n); await runPipeline(); }
    catch (err) { console.error(err); hideLoader(); toast('Sayfa yüklenemedi.'); }
  });

  /* Dışa aktarma düğmeleri */
  $('#pdfBtn').addEventListener('click', exportPdf);
  $('#jpgBtn').addEventListener('click', exportJpg);
  $('#ocrBtn').addEventListener('click', exportOcr);
}

/* Uygulamayı başlat (script defer olduğu için DOM hazırdır) */
bindDropzone();
bindControls();
$$('.view-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === state.view));
