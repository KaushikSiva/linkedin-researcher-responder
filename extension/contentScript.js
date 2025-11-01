const OVERLAY_ID = "autoreply-overlay";
const STYLE_ID = "autoreply-style";
const MESSAGE_THREAD_SELECTOR =
  ".msg-s-message-list-container, .msg-s-message-list, .msg-s-scrollable, .msg-convo-wrapper, [data-view-name=\"message-thread\"], [data-test-id=\"conversation-view\"], [data-qa=\"message_thread\"], [data-test-app=\"messaging-thread\"]";
const MESSAGE_TEXT_SELECTOR = [
  "[data-anonymize=\"message-text\"]",
  ".msg-s-event-listitem__body",
  ".msg-s-message-list__event p",
  ".msg-s-message-list__event span.break-words",
  ".msg-s-message-list__event div[dir]",
  ".msg-s-message-list-item__body",
  ".msg-conversation-listitem__message-snippet",
  ".msg-conversation-card__message-snippet",
  ".msg-s-conversation-card__message-snippet",
  ".message-anywhere__message p",
  ".message-anywhere__message span.break-words"
].join(", ");
const SYSTEM_MESSAGE_PREFIXES = [
  "You are now connected",
  "You accepted",
  "LinkedIn Member",
  "You sent"
];

let overlayDismissed = false;
let lastEditableTarget = null;

document.addEventListener("focusin", event => {
  rememberEditable(event.target);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  if (message.type === "AUTOREPLY_REQUEST_CONTEXT") {
    sendResponse(extractRecruiterContext());
    return;
  }

  switch (message.type) {
    case "AUTOREPLY_STATUS":
      if (message.status === "loading") {
        overlayDismissed = false;
      }
      renderStatus(message.status);
      break;
    case "AUTOREPLY_READY":
      renderReplies(message);
      break;
    case "AUTOREPLY_ERROR":
      renderError(message.message);
      break;
    default:
      break;
  }
});

function renderStatus(status) {
  if (overlayDismissed && status !== "loading") {
    return;
  }

  const overlay = ensureOverlay();
  const container = overlay.querySelector("[data-section=\"content\"]");
  container.innerHTML = "";

  const statusEl = document.createElement("div");
  statusEl.className = "autoreply-status";
  statusEl.textContent = status === "loading" ? "Generating replies..." : status;

  container.append(statusEl);
  updateOverlayVisibility(overlay);
}

function renderReplies(payload) {
  if (overlayDismissed) {
    return;
  }

  const { replies, research, classification } = payload;
  const overlay = ensureOverlay();
  const container = overlay.querySelector("[data-section=\"content\"]");
  container.innerHTML = "";

  if (research) {
    container.append(createResearchBlock(research));
  }

  if (!replies?.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "autoreply-status";
    emptyState.textContent = classification?.isOutreach === false
      ? "No recruiter outreach detected near this composer."
      : "No replies generated. Try again.";
    container.append(emptyState);
  } else {
    replies.forEach((reply, index) => {
      const button = document.createElement("button");
      button.className = "autoreply-option";
      button.type = "button";
      button.dataset.index = String(index);
      button.textContent = reply;
      button.addEventListener("click", () => handleInsert(reply));
      container.append(button);
    });
  }

  updateOverlayVisibility(overlay);
}

function createResearchBlock(research) {
  const block = document.createElement("div");
  block.className = "autoreply-research";
  const glassdoor = research.glassdoor || {};
  const levels = research.levels || {};

  const lines = [
    `<strong>Glassdoor:</strong> ${escapeHtml(glassdoor.amount || "Unavailable")} (${escapeHtml(glassdoor.grade || "N/A")})`,
    `<strong>Levels.fyi:</strong> ${escapeHtml(levels.amount || "Unavailable")} (${escapeHtml(levels.grade || "N/A")})`
  ];

  if (research.overallGrade) {
    lines.push(`<strong>Overall Grade:</strong> ${escapeHtml(research.overallGrade)}`);
  }

  block.innerHTML = lines.join("<br>");
  return block;
}

function renderError(message) {
  if (overlayDismissed) {
    return;
  }

  const overlay = ensureOverlay();
  const container = overlay.querySelector("[data-section=\"content\"]");
  container.innerHTML = "";

  const errorBlock = document.createElement("div");
  errorBlock.className = "autoreply-error";
  errorBlock.textContent = message || "Failed to generate a reply.";

  container.append(errorBlock);
  updateOverlayVisibility(overlay);
}

function handleInsert(text) {
  const target = getInsertionTarget();

  if (target && target.isContentEditable) {
    insertIntoContentEditable(target, text);
    rememberEditable(target);
    closeOverlay("Reply inserted into the composer.", { persistHidden: true });
    return;
  }

  if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
    target.focus();
    target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    rememberEditable(target);
    closeOverlay("Reply inserted into the input.", { persistHidden: true });
    return;
  }

  navigator.clipboard?.writeText(text).catch(() => undefined);
  closeOverlay("Reply copied to clipboard. Paste into LinkedIn.", { persistHidden: true });
}

function insertIntoContentEditable(element, text) {
  element.focus();
  const selection = window.getSelection();
  if (!selection) {
    element.textContent = text;
    return;
  }

  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.addRange(range);
  document.execCommand("insertText", false, text);
}

function closeOverlay(statusMessage, options = {}) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    return;
  }

  const toast = overlay.querySelector("[data-section=\"toast\"]");
  toast.textContent = statusMessage || "";
  if (options.persistHidden) {
    overlayDismissed = true;
  }
  overlay.hidden = true;
  overlay.style.display = "none";

  if (options.persistHidden) {
    overlay.remove();
  }
}

function updateOverlayVisibility(overlay) {
  if (!overlay) {
    return;
  }

  if (overlayDismissed) {
    overlay.hidden = true;
    overlay.style.display = "none";
  } else {
    overlay.hidden = false;
    overlay.style.display = "flex";
  }
}

function extractRecruiterContext() {
  const active = document.activeElement;
  rememberEditable(active);
  if (!active) {
    return {
      primaryText: "",
      contextText: "",
      error: "Place the cursor inside the LinkedIn reply box before generating replies."
    };
  }

  const messagingContext = extractMessagingContext(active);
  if (messagingContext) {
    return messagingContext;
  }

  const articleContext = extractArticleContext(active);
  if (articleContext) {
    return articleContext;
  }

  return {
    primaryText: "",
    contextText: "",
    error: "Couldn't locate the recruiter message near this reply box. Scroll so the outreach is visible and try again."
  };
}

function extractMessagingContext(activeElement) {
  if (!isEditable(activeElement)) {
    return null;
  }

  const threadRoot = findMessagingThreadRoot(activeElement);
  const messageNodes = collectMessageNodes(threadRoot);
  if (!messageNodes.length) {
    return null;
  }

  const texts = dedupeTexts(
    messageNodes
      .map(node => normalizeMessageText(node))
      .filter(Boolean)
  );

  if (!texts.length) {
    return null;
  }

  const contextText = texts.slice(-3).join("\n\n");
  return {
    primaryText: texts[texts.length - 1],
    contextText
  };
}

function extractArticleContext(activeElement) {
  if (!isEditable(activeElement)) {
    return null;
  }

  const article = activeElement.closest("article");
  if (!article) {
    return null;
  }

  const paragraphs = Array.from(
    article.querySelectorAll(
      "section p, section span.break-words, div[dir], p"
    )
  );

  const candidateTexts = paragraphs
    .map(node => normalizeArticleText(node))
    .filter(Boolean);

  const longForm = candidateTexts.sort((a, b) => b.length - a.length)[0];
  const articleText =
    longForm || normalizeArticleText(article) || candidateTexts.join("\n\n");

  if (!articleText) {
    return null;
  }

  return {
    primaryText: longForm || articleText,
    contextText: articleText
  };
}

function findMessagingThreadRoot(activeElement) {
  let node = activeElement;
  const limit = 12;
  let depth = 0;

  while (node && depth < limit) {
    if (node.matches?.(MESSAGE_THREAD_SELECTOR)) {
      return node;
    }
    node = node.parentElement;
    depth += 1;
  }

  return document.body;
}

function collectMessageNodes(root) {
  if (!root) {
    return [];
  }

  const nodes = Array.from(root.querySelectorAll(MESSAGE_TEXT_SELECTOR));
  if (!nodes.length && root !== document.body) {
    return Array.from(document.body.querySelectorAll(MESSAGE_TEXT_SELECTOR));
  }
  return nodes;
}

function normalizeMessageText(node) {
  if (!(node instanceof HTMLElement)) {
    return "";
  }

  if (node.closest(`#${OVERLAY_ID}`)) {
    return "";
  }

  if (!isVisible(node)) {
    return "";
  }

  if (node.closest("[contenteditable=true],[role=\"textbox\"]")) {
    return "";
  }

  const text = collapseWhitespace(node.innerText);
  if (!text) {
    return "";
  }

  if (text.length < 4) {
    return "";
  }

  if (SYSTEM_MESSAGE_PREFIXES.some(prefix => text.startsWith(prefix))) {
    return "";
  }

  return text.slice(0, 1000);
}

function normalizeArticleText(node) {
  if (!(node instanceof HTMLElement)) {
    return "";
  }

  if (!isVisible(node)) {
    return "";
  }

  const text = collapseWhitespace(node.innerText);
  if (!text) {
    return "";
  }

  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function dedupeTexts(values) {
  const seen = new Set();
  const unique = [];

  values.forEach(value => {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  });

  return unique;
}

function collapseWhitespace(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function rememberEditable(element) {
  if (!element) {
    return;
  }

  if (!document.contains(element)) {
    return;
  }

  if (!isEditable(element)) {
    return;
  }

  if (element.closest(`#${OVERLAY_ID}`)) {
    return;
  }

  lastEditableTarget = element;
}

function getInsertionTarget() {
  const active = document.activeElement;
  if (active && document.contains(active) && isEditable(active) && !active.closest(`#${OVERLAY_ID}`)) {
    return active;
  }

  if (lastEditableTarget && document.contains(lastEditableTarget)) {
    return lastEditableTarget;
  }

  return null;
}

function isEditable(element) {
  return (
    element &&
    (element.isContentEditable ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "INPUT")
  );
}

function isVisible(element) {
  if (!element) {
    return false;
  }

  const rects = element.getClientRects();
  if (!rects.length) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

function ensureOverlay() {
  injectStyles();

  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "autoreply-overlay";

  const header = document.createElement("div");
  header.className = "autoreply-header";
  header.innerHTML = "<span>AutoReply Recruiter</span>";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "autoreply-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", () => closeOverlay(undefined, { persistHidden: true }));
  header.append(close);

  const content = document.createElement("div");
  content.className = "autoreply-content";
  content.dataset.section = "content";

  const toast = document.createElement("div");
  toast.className = "autoreply-toast";
  toast.dataset.section = "toast";
  toast.textContent = "";

  overlay.append(header, content, toast);
  document.body.append(overlay);

  return overlay;
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .autoreply-overlay {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: min(360px, 90vw);
      max-height: 70vh;
      background: #ffffff;
      color: #1a1a1a;
      border-radius: 12px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.18);
      border: 1px solid rgba(0, 0, 0, 0.08);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .autoreply-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 16px;
      background: #0a66c2;
      color: #ffffff;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .autoreply-close {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
    }

    .autoreply-content {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
    }

    .autoreply-source,
    .autoreply-research,
    .autoreply-classification {
      font-size: 13px;
      background: rgba(10, 102, 194, 0.08);
      border-left: 3px solid #0a66c2;
      padding: 8px;
      border-radius: 6px;
      white-space: pre-wrap;
    }

    .autoreply-source {
      background: rgba(10, 102, 194, 0.04);
      border-color: rgba(10, 102, 194, 0.4);
    }

    .autoreply-research {
      background: rgba(10, 102, 194, 0.06);
      border-color: rgba(10, 102, 194, 0.5);
    }

    .autoreply-classification {
      background: rgba(10, 102, 194, 0.12);
      border-color: rgba(10, 102, 194, 0.6);
    }

    .autoreply-classification.not-outreach {
      background: rgba(208, 65, 65, 0.12);
      border-color: rgba(208, 65, 65, 0.6);
      color: #b3261e;
    }

    .autoreply-option {
      text-align: left;
      border: 1px solid rgba(10, 102, 194, 0.32);
      background: #ffffff;
      color: #0a66c2;
      border-radius: 10px;
      padding: 10px 12px;
      line-height: 1.4;
      font-size: 13px;
      cursor: pointer;
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.1s ease;
      white-space: pre-wrap;
    }

    .autoreply-option:hover {
      border-color: #0a66c2;
      box-shadow: 0 4px 12px rgba(10, 102, 194, 0.2);
      transform: translateY(-1px);
    }

    .autoreply-status,
    .autoreply-error {
      font-size: 14px;
      padding: 12px;
      border-radius: 8px;
    }

    .autoreply-status {
      background: rgba(10, 102, 194, 0.08);
      color: #0a66c2;
    }

    .autoreply-error {
      background: rgba(208, 65, 65, 0.12);
      color: #b3261e;
    }

    .autoreply-toast {
      font-size: 12px;
      padding: 10px 16px;
      background: #f3f2ef;
      color: #666666;
      border-top: 1px solid rgba(0, 0, 0, 0.08);
      min-height: 16px;
    }
  `;

  document.head.append(style);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, match => {
    switch (match) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return match;
    }
  });
}
