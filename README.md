AutoReply Recruiter – Gemini Nano Edition
=========================================

This Chrome extension prototype runs entirely on-device and generates context-aware replies to recruiter outreach on LinkedIn using Chrome’s Prompt + Summarizer + Writer + Proofreader APIs. Place your cursor in any LinkedIn reply box, right-click, and let the extension privately summarize, classify, and draft a response without leaving the browser.

Project layout
--------------

- `extension/manifest.json` – Manifest V3 configuration and permissions.
- `extension/background.js` – Registers the context menu and orchestrates summarization, generation, and proofreading with Chrome AI APIs.
- `extension/contentScript.js` – Injects a lightweight overlay on LinkedIn, displays reply options, and inserts the chosen response.

Chrome setup
------------

1. Use Chrome Canary 127+ (the on-device AI APIs are gated behind current Dev/Canary builds).
2. Enable the required experimental flags (restart after toggling):
   - `chrome://flags/#prompt-api-for-productivity`
   - `chrome://flags/#enable-desktop-pwas-ai-integration` (if available in your build)
3. In `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**. Select the `extension` folder from this project.

Using the extension
-------------------

1. Open LinkedIn in Chrome and navigate to a recruiter DM or post.
2. Place your cursor inside the reply/comment box (no highlighting required).
3. Right-click and choose **Generate Smart Reply** from the context menu.
4. The extension captures the latest recruiter message, summarizes it, then classifies whether it’s actually a recruiter outreach (works in full-page threads and the pop-out messaging window).
5. When it looks like outreach, you’ll see two ready-to-send replies (“Yes, I'm interested…” and “Thanks for reaching out…”). If not, the overlay lets you know nothing was generated.

Notes & next steps
------------------

- Do more research about the company or role
- Allow to write templates which can be customized
