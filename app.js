"use strict";

/* ---------- Config ---------- */
const PROXY_URL = "https://slidecraft-proxy.shibasisn2.workers.dev/generate";

/* ---------- Theme palette (kept in sync with styles.css theme-* classes) ---------- */
const THEMES = {
  ocean:    { primary: "0B5FFF", light: "EAF2FF", dark: "0B1A3A", accent: "00C2D1" },
  sunset:   { primary: "FF7A45", light: "FFF3E6", dark: "3A1F00", accent: "FFC53D" },
  forest:   { primary: "1F9254", light: "EAF7EE", dark: "123A20", accent: "73D13D" },
  royal:    { primary: "6C3CE9", light: "F2ECFF", dark: "2A1650", accent: "FFD666" },
  midnight: { primary: "1E2A4A", light: "EEF0F6", dark: "131B2E", accent: "4CD9C0" },
};

/* ---------- State ---------- */
const state = {
  docText: "",
  docName: "",
  deckTitle: "",
  slides: [],
  currentIndex: 0,
};

/* ---------- DOM refs ---------- */
const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const dropzoneText = $("dropzone-text");
const docxInput = $("docx-input");
const docPreview = $("doc-preview");
const docNameEl = $("doc-name");
const docExcerptEl = $("doc-excerpt");
const clearDocBtn = $("clear-doc-btn");
const generateBtn = $("generate-btn");
const chatLog = $("chat-log");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const chatSendBtn = $("chat-send-btn");
const deckTitleEl = $("deck-title");
const slideCounterEl = $("slide-counter");
const prevBtn = $("prev-btn");
const nextBtn = $("next-btn");
const exportBtn = $("export-btn");
const slideStage = $("slide-stage");
const slideGrid = $("slide-grid");
const toast = $("toast");

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(msg, kind) {
  toast.textContent = msg;
  toast.className = "toast" + (kind ? " " + kind : "");
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

/* ---------- Document upload ---------- */
function updateGenerateEnabled() {
  generateBtn.disabled = !state.docText;
}

async function handleDocxFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".docx")) {
    showToast("Please choose a .docx file.", "error");
    return;
  }
  try {
    dropzoneText.textContent = "Reading document…";
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    state.docText = result.value.trim();
    state.docName = file.name;
    if (!state.docText) {
      showToast("Couldn't find any text in that document.", "error");
      dropzoneText.textContent = "Click to choose a .docx file, or drag it here";
      return;
    }
    docNameEl.textContent = file.name;
    docExcerptEl.textContent = state.docText.slice(0, 320) + (state.docText.length > 320 ? "…" : "");
    docPreview.hidden = false;
    dropzoneText.textContent = "Click to choose a different .docx file";
    updateGenerateEnabled();
    showToast("Document loaded — ready to generate.", "success");
  } catch (err) {
    console.error(err);
    showToast("Couldn't read that .docx file: " + err.message, "error");
    dropzoneText.textContent = "Click to choose a .docx file, or drag it here";
  }
}

docxInput.addEventListener("change", (e) => handleDocxFile(e.target.files[0]));
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleDocxFile(file);
});
clearDocBtn.addEventListener("click", () => {
  state.docText = "";
  state.docName = "";
  docxInput.value = "";
  docPreview.hidden = true;
  updateGenerateEnabled();
});

/* ---------- Chat log rendering ---------- */
function addChatBubble(role, html) {
  const div = document.createElement("div");
  div.className = "chat-bubble chat-" + role;
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ---------- Proxy call ---------- */
async function callProxy(userPrompt) {
  const contextParts = [];
  if (state.docText) {
    contextParts.push(`SOURCE DOCUMENT (may be truncated):\n${state.docText.slice(0, 12000)}`);
  }
  if (state.slides.length) {
    contextParts.push(`CURRENT DECK JSON:\n${JSON.stringify({ deckTitle: state.deckTitle, slides: state.slides })}`);
  }
  contextParts.push(`USER INSTRUCTION:\n${userPrompt}`);
  const prompt = contextParts.join("\n\n---\n\n");

  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (!data.slides || !Array.isArray(data.slides) || !data.slides.length) {
    throw new Error("The AI didn't return any slides. Try again.");
  }
  return data;
}

async function requestDeck(instruction, { isInitial } = {}) {
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  generateBtn.disabled = true;
  const thinkingBubble = document.createElement("div");
  thinkingBubble.className = "chat-bubble chat-system";
  thinkingBubble.textContent = isInitial ? "Designing your deck…" : "Updating your deck…";
  chatLog.appendChild(thinkingBubble);
  chatLog.scrollTop = chatLog.scrollHeight;

  try {
    const result = await callProxy(instruction);
    state.deckTitle = result.deckTitle || state.deckTitle || "Untitled Deck";
    state.slides = result.slides;
    state.currentIndex = Math.min(state.currentIndex, state.slides.length - 1);
    if (state.currentIndex < 0) state.currentIndex = 0;
    thinkingBubble.remove();
    addChatBubble(
      "assistant",
      `<p>Done — <strong>${escapeHtml(state.deckTitle)}</strong>, ${state.slides.length} slide${state.slides.length === 1 ? "" : "s"}.</p>`
    );
    renderDeck();
    showToast("Deck updated.", "success");
  } catch (err) {
    console.error(err);
    thinkingBubble.remove();
    addChatBubble("error", escapeHtml(err.message));
    showToast(err.message, "error");
  } finally {
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    updateGenerateEnabled();
    chatInput.focus();
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

generateBtn.addEventListener("click", () => {
  addChatBubble("user", "Generate a slide outline from my document.");
  requestDeck(
    "Create the initial slide deck outline from the source document above. Aim for a clear, well-paced deck (roughly one slide per major idea).",
    { isInitial: true }
  );
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (!msg) return;
  addChatBubble("user", escapeHtml(msg));
  chatInput.value = "";
  requestDeck(msg);
});

/* ---------- Deck rendering ---------- */
function slideRenderHTML(slide) {
  const bullets = (slide.bullets || [])
    .filter(Boolean)
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join("");
  return `
    <div class="slide-render theme-${slide.theme} layout-${slide.layout}">
      ${slide.layout === "content" ? '<div class="accent-bar"></div>' : ""}
      <h3 class="s-title">${escapeHtml(slide.title || "")}</h3>
      ${bullets ? `<ul class="s-bullets">${bullets}</ul>` : ""}
    </div>`;
}

function renderDeck() {
  const hasSlides = state.slides.length > 0;
  deckTitleEl.textContent = hasSlides ? state.deckTitle : "No deck yet";
  slideCounterEl.textContent = hasSlides ? `Slide ${state.currentIndex + 1} of ${state.slides.length}` : "";
  prevBtn.disabled = !hasSlides || state.currentIndex === 0;
  nextBtn.disabled = !hasSlides || state.currentIndex === state.slides.length - 1;
  exportBtn.disabled = !hasSlides;

  if (!hasSlides) {
    slideStage.classList.add("empty");
    slideStage.innerHTML = '<div class="empty-state"><p>Your slide preview will appear here.</p></div>';
    slideGrid.innerHTML = "";
    return;
  }

  slideStage.classList.remove("empty");
  slideStage.innerHTML = slideRenderHTML(state.slides[state.currentIndex]);

  slideGrid.innerHTML = "";
  state.slides.forEach((slide, i) => {
    const thumb = document.createElement("div");
    thumb.className = "slide-thumb" + (i === state.currentIndex ? " active" : "");
    thumb.innerHTML = slideRenderHTML(slide) + `<span class="thumb-num">${i + 1}</span>`;
    thumb.addEventListener("click", () => {
      state.currentIndex = i;
      renderDeck();
    });
    slideGrid.appendChild(thumb);
  });
}

prevBtn.addEventListener("click", () => {
  if (state.currentIndex > 0) { state.currentIndex--; renderDeck(); }
});
nextBtn.addEventListener("click", () => {
  if (state.currentIndex < state.slides.length - 1) { state.currentIndex++; renderDeck(); }
});

/* ---------- Export to PPTX ---------- */
function buildPptx() {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";

  state.slides.forEach((slide) => {
    const theme = THEMES[slide.theme] || THEMES.ocean;
    const s = pptx.addSlide();

    if (slide.layout === "content") {
      s.background = { color: theme.light };
      s.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.35, fill: { color: theme.primary } });
      s.addText(slide.title || "", {
        x: 0.6, y: 0.7, w: "90%", h: 0.9,
        fontSize: 30, bold: true, color: theme.dark, fontFace: "Segoe UI",
      });
      const bulletLines = (slide.bullets || []).filter(Boolean).map((b) => ({
        text: b,
        options: { bullet: { code: "25CF", color: theme.primary }, breakLine: true, paraSpaceAfter: 12 },
      }));
      if (bulletLines.length) {
        s.addText(bulletLines, {
          x: 0.8, y: 1.8, w: "85%", h: 5,
          fontSize: 20, color: theme.dark, fontFace: "Segoe UI", valign: "top",
        });
      }
    } else {
      // title or section: full-bleed color background, centered text
      s.background = { color: theme.primary };
      s.addShape("rect", {
        x: 0, y: 4.9, w: "100%", h: 0.12, fill: { color: theme.accent },
      });
      s.addText(slide.title || "", {
        x: 0.8, y: slide.layout === "title" ? 2.7 : 3.1, w: 11.73, h: 1.6,
        align: "center", fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Segoe UI",
      });
      const sub = (slide.bullets || []).filter(Boolean)[0];
      if (sub) {
        s.addText(sub, {
          x: 0.8, y: slide.layout === "title" ? 4.1 : 4.3, w: 11.73, h: 0.8,
          align: "center", fontSize: 18, color: "FFFFFF", fontFace: "Segoe UI",
        });
      }
    }
  });

  return pptx;
}

exportBtn.addEventListener("click", () => {
  if (!state.slides.length) return;
  try {
    const pptx = buildPptx();
    const safeName = (state.deckTitle || "presentation").replace(/[^a-z0-9\- _]/gi, "").trim() || "presentation";
    pptx.writeFile({ fileName: `${safeName}.pptx` });
    showToast("Downloading .pptx …", "success");
  } catch (err) {
    console.error(err);
    showToast("Export failed: " + err.message, "error");
  }
});

renderDeck();
