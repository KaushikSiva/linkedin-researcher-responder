const MENU_ID = "autoreply-generate";
const REPLY_TEMPLATES = Object.freeze([
  "Yes, I'm interested. My number is +12149098059.",
  "Thanks for reaching out. I'm currently not looking to move but will ping at a later time."
]);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Generate Smart Reply",
    contexts: ["editable"],
    documentUrlPatterns: ["https://*.linkedin.com/*"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) {
    return;
  }

  postToContent(tab.id, info.frameId, {
    type: "AUTOREPLY_STATUS",
    status: "loading"
  });

  try {
    const selectionText = info.selectionText?.trim();
    let context;

    try {
      context = await requestRecruiterContext(tab.id, info.frameId);
    } catch (error) {
      if (selectionText) {
        context = {
          primaryText: selectionText,
          contextText: selectionText
        };
      } else {
        throw error;
      }
    }

    const contextText = context?.contextText?.trim();
    const recruiterText = (context?.primaryText || selectionText || "").trim();

    if (!recruiterText) {
      throw new Error(
        context?.error ||
          "Couldn't capture the recruiter message. Make sure the thread is visible, place the cursor in the reply box, and try again."
      );
    }

    const summarySource = contextText || recruiterText;
    const summary = await summarizeRecruiterPitch(summarySource);
    const classification = await classifyRecruiterOutreach({
      summary,
      recruiterText,
      contextText: contextText || ""
    });
    const personalization = await extractPersonalization({
      summary,
      recruiterText,
      contextText: contextText || ""
    });
    const replies = classification.isOutreach
      ? buildReplies(personalization)
      : [];
    const polishedReplies = await polishReplies(replies);
    const research = await researchOpportunity({
      summary,
      recruiterText,
      contextText: contextText || ""
    });

    postToContent(tab.id, info.frameId, {
      type: "AUTOREPLY_READY",
      summary,
      original: recruiterText,
      context: contextText,
      classification,
      replies: polishedReplies,
      research
    });
  } catch (error) {
    postToContent(tab.id, info.frameId, {
      type: "AUTOREPLY_ERROR",
      message: error?.message || "Something went wrong while generating replies."
    });
  }
});

async function summarizeRecruiterPitch(text) {
  if (chrome.ai?.summarizer?.create) {
    try {
      const session = await chrome.ai.summarizer.create({
        type: "tl;dr"
      });
      const result = await session.summarize({
        text,
        format: "plain-text",
        length: "medium"
      });
      session.destroy?.();
      return (
        result?.summary ||
        result?.summaries?.[0]?.text ||
        trunc(text, 300)
      );
    } catch (error) {
      console.warn("Summarizer failed, falling back to heuristic summary", error);
    }
  }

  return trunc(text, 300);
}

async function polishReplies(replies) {
  if (!Array.isArray(replies) || replies.length === 0) {
    return [];
  }

  if (chrome.ai?.proofreader?.create) {
    try {
      const proofreader = await chrome.ai.proofreader.create({
        task: "proofread"
      });

      const polished = [];
      for (const reply of replies) {
        const result = await proofreader.proofread({
          text: reply
        });
        polished.push(result?.text || result?.outputText || reply);
      }

      proofreader.destroy?.();
      return polished;
    } catch (error) {
      console.warn("Proofreader failed, returning unpolished replies", error);
    }
  }

  return replies;
}

function trunc(text, length) {
  if (!text || text.length <= length) {
    return text;
  }
  return `${text.slice(0, length - 1).trim()}…`;
}

async function extractPersonalization({ summary, recruiterText, contextText }) {
  const fallback = {
    recruiterName: null,
    userName: null
  };

  if (!chrome.ai?.writer?.create) {
    return fallback;
  }

  let writer;
  try {
    writer = await chrome.ai.writer.create();
    const prompt = [
      "You analyze LinkedIn recruiter conversations.",
      "Return a compact JSON object with keys recruiterFirstName and candidateFirstName containing only the likely first names.",
      "Use the recruiter's message to infer their name, and infer the candidate's name (the person being recruited) if it appears.",
      "If uncertain, return an empty string for that field.",
      "JSON only. No markdown, no explanation.",
      "Recruiter message:",
      recruiterText,
      contextText && recruiterText !== contextText ? `Additional context: ${contextText}` : "",
      summary ? `Summary: ${summary}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await writer.generate({ prompt });
    const output =
      result?.text ||
      result?.outputText ||
      result?.candidates?.[0]?.outputText ||
      "";
    const parsed = parseNameJson(output);
    return parsed || fallback;
  } catch (error) {
    console.warn("Personalization extraction failed; using fallback.", error);
    return fallback;
  } finally {
    writer?.destroy?.();
  }
}

function buildReplies({ recruiterName, userName }) {
  const greeting = recruiterName ? `Hi ${recruiterName},` : "Hi,";

  const closing = userName
    ? `Thanks\n${userName}`
    : "Thanks";

  return REPLY_TEMPLATES.map(template => `${greeting} ${template}\n\n${closing}`);
}

async function researchOpportunity({ summary, recruiterText, contextText }) {
  const fallback = {
    glassdoor: { amount: "Unavailable", grade: "N/A" },
    levels: { amount: "Unavailable", grade: "N/A" },
    overallGrade: "Unknown"
  };
  const metadata = resolveRoleMetadata({ summary, recruiterText, contextText });
  const heuristic = heuristicCompEstimate(metadata);

  const [levelsLive, glassdoorLive] = await Promise.all([
    fetchLevelsComp(metadata).catch(error => {
      console.warn("Levels.fyi fetch failed, falling back.", error);
      return null;
    }),
    fetchGlassdoorComp(metadata).catch(error => {
      console.warn("Glassdoor fetch failed, falling back.", error);
      return null;
    })
  ]);

  let aiSuggestion = null;
  if (chrome.ai?.writer?.create) {
    let writer;
    try {
      writer = await chrome.ai.writer.create();
      const prompt = [
        "You are a compensation research assistant.",
        "Estimate typical total annual compensation for this opportunity using public Glassdoor and Levels.fyi data as references.",
        "Return a compact JSON object with keys glassdoorAmount (string), glassdoorGrade (string), levelsAmount (string), levelsGrade (string), overallGrade (string).",
        "Express dollar amounts as ranges like \"$180k-$220k\". Grades should be A, B, C, etc.",
        "Do not include markdown, code fences, or explanation—JSON only.",
        "Recruiter message:",
        recruiterText,
        contextText && contextText !== recruiterText ? `Additional context: ${contextText}` : "",
        summary ? `Summary: ${summary}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");

      const result = await writer.generate({ prompt });
      const output =
        result?.text ||
        result?.outputText ||
        result?.candidates?.[0]?.outputText ||
        "";
      aiSuggestion = parseResearchJson(output);
    } catch (error) {
      console.warn("Compensation research (AI) failed, ignoring.", error);
    } finally {
      writer?.destroy?.();
    }
  }

  const glassdoorChoice = pickFirstResult(
    aiSuggestion?.glassdoor,
    glassdoorLive?.glassdoor,
    heuristic?.glassdoor,
    fallback.glassdoor
  );

  const levelsChoice = pickFirstResult(
    aiSuggestion?.levels,
    levelsLive?.levels,
    heuristic?.levels,
    fallback.levels
  );

  const overallGrade =
    aiSuggestion?.overallGrade ||
    levelsLive?.overallGrade ||
    glassdoorLive?.overallGrade ||
    heuristic?.overallGrade ||
    fallback.overallGrade;

  return {
    glassdoor: glassdoorChoice,
    levels: levelsChoice,
    overallGrade
  };
}

function parseResearchJson(raw) {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim().replace(/```json|```/gi, "");
  try {
    const parsed = JSON.parse(trimmed);
    return {
      glassdoor: {
        amount: sanitizeResearchValue(parsed.glassdoorAmount),
        grade: sanitizeResearchValue(parsed.glassdoorGrade)
      },
      levels: {
        amount: sanitizeResearchValue(parsed.levelsAmount),
        grade: sanitizeResearchValue(parsed.levelsGrade)
      },
      overallGrade: sanitizeResearchValue(parsed.overallGrade)
    };
  } catch (error) {
    console.debug("Failed to parse research JSON:", error, trimmed);
    return null;
  }
}

function sanitizeResearchValue(value) {
  if (!value) {
    return "Unavailable";
  }
  return String(value).trim();
}

function parseNameJson(raw) {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim().replace(/```json|```/gi, "");
  try {
    const parsed = JSON.parse(trimmed);
    return {
      recruiterName: sanitizeFirstName(parsed.recruiterFirstName),
      userName: sanitizeFirstName(parsed.candidateFirstName)
    };
  } catch (error) {
    console.debug("Failed to parse personalization JSON:", error, trimmed);
    return null;
  }
}

function sanitizeFirstName(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  const match = text.match(/[A-Za-z][A-Za-z' -]*/);
  if (!match) {
    return null;
  }

  const name = match[0].split(/[\s-]/)[0];
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

const DEFAULT_ROLE = "Software Engineer";
const DEFAULT_LOCATION = "United States";

function resolveRoleMetadata({ summary, recruiterText, contextText }) {
  const fragments = [summary, recruiterText, contextText].filter(Boolean);
  const combinedText = fragments.join("\n");
  const lower = combinedText.toLowerCase();

  const roleMappings = [
    { pattern: /\b(product\s+manager|pm)\b/, role: "Product Manager" },
    { pattern: /\b(data\s+scientist|ml\s+engineer|machine\s+learning)\b/, role: "Data Scientist" },
    { pattern: /\b(data\s+engineer)\b/, role: "Data Engineer" },
    { pattern: /\b(android|ios|mobile)\b/, role: "Mobile Software Engineer" },
    { pattern: /\b(front\s*end|frontend|react|angular)\b/, role: "Front End Engineer" },
    { pattern: /\b(back\s*end|backend|server|api)\b/, role: "Back End Engineer" },
    { pattern: /\b(full\s*stack)\b/, role: "Full Stack Engineer" },
    { pattern: /\b(designer|ux|ui)\b/, role: "Product Designer" },
    { pattern: /\b(devops|site reliability|sre)\b/, role: "Site Reliability Engineer" },
    { pattern: /\b(security engineer|application security)\b/, role: "Security Engineer" }
  ];

  let role = DEFAULT_ROLE;
  for (const mapping of roleMappings) {
    if (mapping.pattern.test(lower)) {
      role = mapping.role;
      break;
    }
  }

  const seniorityMappings = [
    { pattern: /\b(intern|internship)\b/, level: "intern" },
    { pattern: /\b(junior|entry|new grad)\b/, level: "junior" },
    { pattern: /\b(mid[-\s]?level|midlevel)\b/, level: "mid" },
    { pattern: /\b(senior|sr\.)\b/, level: "senior" },
    { pattern: /\b(staff|principal|architect)\b/, level: "staff" },
    { pattern: /\b(manager|lead)\b/, level: "lead" },
    { pattern: /\b(director|vp|vice president|executive|head)\b/, level: "executive" }
  ];

  let seniority = "mid";
  for (const mapping of seniorityMappings) {
    if (mapping.pattern.test(lower)) {
      seniority = mapping.level;
      break;
    }
  }

  const locationMappings = [
    { pattern: /\b(san\s+francisco|sf|bay\s+area|silicon\s+valley|mountain\s+view|menlo\s+park|sunnyvale)\b/, location: "San Francisco Bay Area" },
    { pattern: /\b(new\s+york|nyc|manhattan|brooklyn)\b/, location: "New York NY" },
    { pattern: /\b(seattle|redmond|bellevue)\b/, location: "Seattle WA" },
    { pattern: /\b(austin)\b/, location: "Austin TX" },
    { pattern: /\b(denver|boulder)\b/, location: "Denver CO" },
    { pattern: /\b(atlanta)\b/, location: "Atlanta GA" },
    { pattern: /\b(phoenix)\b/, location: "Phoenix AZ" },
    { pattern: /\b(salt\s+lake|utah)\b/, location: "Salt Lake City UT" },
    { pattern: /\b(chicago)\b/, location: "Chicago IL" },
    { pattern: /\b(boston)\b/, location: "Boston MA" },
    { pattern: /\b(remote)\b/, location: "Remote" }
  ];

  let location = DEFAULT_LOCATION;
  for (const mapping of locationMappings) {
    if (mapping.pattern.test(lower)) {
      location = mapping.location;
      break;
    }
  }

  return { role, location, seniority, combinedText };
}

async function fetchLevelsComp(metadata) {
  const role = metadata.role || DEFAULT_ROLE;
  const url = `https://www.levels.fyi/js/titles/${encodeURIComponent(role)}.json`;
  const response = await fetch(url, { method: "GET", mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Levels.fyi HTTP ${response.status}`);
  }

  const payload = await response.json();
  const entries = extractLevelEntries(payload);
  if (!entries.length) {
    throw new Error("Levels.fyi payload empty");
  }

  const filtered = filterEntriesByLocation(entries, metadata.location);
  const usable = (filtered.length ? filtered : entries)
    .map(extractCompValue)
    .filter(value => Number.isFinite(value) && value > 5000);

  if (!usable.length) {
    throw new Error("Levels.fyi missing compensation values");
  }

  usable.sort((a, b) => a - b);
  const median = percentile(usable, 0.5);
  const p25 = percentile(usable, 0.25) ?? usable[0];
  const p75 = percentile(usable, 0.75) ?? usable[usable.length - 1];

  const amount = formatCompRange(p25, p75);
  const grade = gradeFromComp(median);

  return {
    levels: { amount, grade },
    overallGrade: grade
  };
}

function extractLevelEntries(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.levels)) {
    return data.levels;
  }

  if (Array.isArray(data?.entries)) {
    return data.entries;
  }

  return [];
}

function filterEntriesByLocation(entries, location) {
  if (!location || location === DEFAULT_LOCATION) {
    return [];
  }

  const needle = location.toLowerCase();
  const matches = entries.filter(entry => {
    if (!entry) {
      return false;
    }
    const entryLocation = typeof entry.location === "string"
      ? entry.location
      : typeof entry.city === "string"
        ? entry.city
        : Array.isArray(entry) && entry.length > 1
          ? String(entry[1])
          : "";
    return entryLocation.toLowerCase().includes(needle);
  });

  return matches;
}

function extractCompValue(entry) {
  if (!entry) {
    return NaN;
  }

  if (typeof entry === "number") {
    return entry;
  }

  const candidates = [
    entry.totalyearlycompensation,
    entry.total_compensation,
    entry.totalCompensation,
    entry.tc,
    entry.total,
    entry.compensation,
    entry.salary,
    Array.isArray(entry) ? entry[entry.length - 1] : undefined
  ];

  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }
    const numeric = Number(
      typeof candidate === "string" ? candidate.replace(/[^\d.]/g, "") : candidate
    );
    if (Number.isFinite(numeric) && numeric > 1000) {
      return numeric;
    }
  }

  return NaN;
}

async function fetchGlassdoorComp(metadata) {
  const roleSlug = slugify(metadata.role || DEFAULT_ROLE);
  const locationSlug = metadata.location && metadata.location !== DEFAULT_LOCATION
    ? slugify(metadata.location)
    : null;

  const roleLength = roleSlug.replace(/-/g, "").length;
  const basePath = locationSlug
    ? `${locationSlug}-${roleSlug}-salary-SRCH.htm`
    : `${roleSlug}-salary-SRCH_KO0,${Math.min(roleLength, 28)}.htm`;

  const url = locationSlug
    ? `https://www.glassdoor.com/Salaries/${basePath}`
    : `https://www.glassdoor.com/Salaries/${basePath}`;

  const response = await fetch(url, { method: "GET", mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Glassdoor HTTP ${response.status}`);
  }

  const html = await response.text();
  const percentiles = parseGlassdoorPercentiles(html);
  if (!percentiles) {
    throw new Error("Glassdoor payload missing percentiles");
  }

  const amount = formatCompRange(percentiles.p25, percentiles.p75);
  const grade = gradeFromComp(percentiles.p50);

  return {
    glassdoor: { amount, grade },
    overallGrade: grade
  };
}

function parseGlassdoorPercentiles(html) {
  if (!html) {
    return null;
  }

  const match = html.match(/"payPercentileSalary":\s*(\{[^}]+\})/);
  if (!match) {
    return null;
  }

  try {
    const data = JSON.parse(match[1]);
    const p25 = Number(data["25"]);
    const p50 = Number(data["50"]);
    const p75 = Number(data["75"]);
    if ([p25, p50, p75].every(value => Number.isFinite(value))) {
      return { p25, p50, p75 };
    }
    return null;
  } catch (error) {
    console.debug("Glassdoor percentile parse failed:", error);
    return null;
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function percentile(values, p) {
  if (!values.length) {
    return undefined;
  }

  if (values.length === 1) {
    return values[0];
  }

  const position = (values.length - 1) * p;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;

  if (upperIndex >= values.length) {
    return values[values.length - 1];
  }

  const lower = values[lowerIndex];
  const upper = values[upperIndex];
  return lower + (upper - lower) * weight;
}

function gradeFromComp(median) {
  if (!Number.isFinite(median)) {
    return "Unknown";
  }

  const k = median / 1000;
  if (k >= 400) return "A+";
  if (k >= 330) return "A";
  if (k >= 280) return "A-";
  if (k >= 240) return "B+";
  if (k >= 200) return "B";
  if (k >= 160) return "B-";
  if (k >= 130) return "C+";
  if (k >= 100) return "C";
  return "C-";
}

function pickFirstResult(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeCompCandidate(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return { amount: "Unavailable", grade: "N/A" };
}

function normalizeCompCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === "string") {
    return { amount: candidate, grade: "N/A" };
  }

  if (typeof candidate === "object") {
    const amount =
      candidate.amount ||
      candidate.range ||
      candidate.value ||
      candidate.avg ||
      candidate.mean;

    if (!amount) {
      return null;
    }

    return {
      amount: String(amount),
      grade: candidate.grade ? String(candidate.grade) : "N/A"
    };
  }

  return null;
}

function heuristicCompEstimate(metadata) {
  const text = metadata.combinedText?.toLowerCase() || "";
  if (!text) {
    return null;
  }

  const roleBaselines = {
    "Product Manager": [130_000, 190_000],
    "Data Scientist": [135_000, 195_000],
    "Data Engineer": [130_000, 190_000],
    "Mobile Software Engineer": [140_000, 205_000],
    "Front End Engineer": [130_000, 185_000],
    "Back End Engineer": [140_000, 210_000],
    "Full Stack Engineer": [135_000, 200_000],
    "Product Designer": [110_000, 160_000],
    "Site Reliability Engineer": [145_000, 215_000],
    "Security Engineer": [150_000, 220_000],
    "Software Engineer": [140_000, 200_000]
  };

  let [min, max] = roleBaselines[metadata.role] || [120_000, 170_000];

  const seniorityAdjustments = {
    intern: -80_000,
    junior: -30_000,
    mid: 0,
    senior: 40_000,
    staff: 80_000,
    lead: 70_000,
    executive: 140_000
  };

  const seniorityBoost = seniorityAdjustments[metadata.seniority] ?? 0;
  min += seniorityBoost;
  max += seniorityBoost;

  const locationAdjustments = [
    { pattern: /san\s+francisco|bay\s+area|silicon\s+valley|mountain\s+view|menlo\s+park|sunnyvale/, boost: 45_000 },
    { pattern: /new\s+york|nyc|manhattan|brooklyn/, boost: 35_000 },
    { pattern: /seattle|redmond|bellevue/, boost: 25_000 },
    { pattern: /austin|denver|atlanta|phoenix|salt\s+lake|raleigh|charlotte/, boost: -10_000 },
    { pattern: /remote/, boost: -5_000 }
  ];

  for (const adjustment of locationAdjustments) {
    if (adjustment.pattern.test(text)) {
      min += adjustment.boost;
      max += adjustment.boost;
      break;
    }
  }

  min = Math.max(45_000, min);
  max = Math.max(min + 15_000, max);

  const median = (min + max) / 2;
  const grade = gradeFromComp(median);

  return {
    glassdoor: { amount: formatCompRange(min, max), grade },
    levels: { amount: formatCompRange(min + 10_000, max + 15_000), grade },
    overallGrade: grade
  };
}

function formatCompRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return "Unavailable";
  }
  const roundedMin = Math.round(min / 5000) * 5;
  const roundedMax = Math.round(max / 5000) * 5;
  return `$${roundedMin}k-$${roundedMax}k`;
}

async function requestRecruiterContext(tabId, frameId) {
  try {
    return await sendMessage(tabId, { type: "AUTOREPLY_REQUEST_CONTEXT" }, frameId);
  } catch (error) {
    if (
      typeof error?.message === "string" &&
      error.message.includes("Receiving end does not exist")
    ) {
      throw new Error(
        "LinkedIn is still loading this thread. Wait a moment, place the cursor in the reply box, and try again."
      );
    }
    throw error;
  }
}

function sendMessage(tabId, message, frameId) {
  return new Promise((resolve, reject) => {
    const options = typeof frameId === "number" ? { frameId } : undefined;
    chrome.tabs.sendMessage(tabId, message, options, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function postToContent(tabId, frameId, message) {
  const options = typeof frameId === "number" ? { frameId } : undefined;
  chrome.tabs.sendMessage(tabId, message, options, () => {
    // Ignore missing receiver errors (e.g., frame navigated away).
    if (chrome.runtime.lastError) {
      console.debug("AutoReply postToContent:", chrome.runtime.lastError.message);
    }
  });
}

async function classifyRecruiterOutreach({ summary, recruiterText, contextText }) {
  const combined = [
    "Recruiter message:",
    recruiterText,
    contextText && recruiterText !== contextText ? `Additional context:\n${contextText}` : "",
    "Summary:",
    summary
  ]
    .filter(Boolean)
    .join("\n\n");

  const heuristic = heuristicOutreachDetection(recruiterText, summary);

  if (chrome.ai?.writer?.create) {
    let writer;
    try {
      writer = await chrome.ai.writer.create();
      const result = await writer.generate({
        prompt: [
          "You are a classifier for LinkedIn conversations.",
          "Return the single word OUTREACH if the text clearly looks like a recruiter or hiring outreach (pitching a role, asking to chat, job opportunity, interview).",
          "Otherwise return OTHER.",
          "Do not add any extra words.",
          "TEXT:",
          combined
        ].join("\n")
      });

      const raw = (result?.candidates?.[0]?.outputText || result?.text || "").trim();
      const normalized = raw.replace(/[^A-Z]/gi, "").toUpperCase();
      if (normalized.startsWith("OUTREACH")) {
        return {
          label: "outreach",
          isOutreach: true,
          source: "writer",
          raw
        };
      }
      if (normalized.startsWith("OTHER")) {
        if (heuristic) {
          return {
            label: "outreach",
            isOutreach: true,
            source: "writer+heuristic",
            raw
          };
        }
        return {
          label: "other",
          isOutreach: false,
          source: "writer",
          raw
        };
      }
    } catch (error) {
      console.warn("Writer outreach classification failed; falling back to heuristics", error);
    } finally {
      writer?.destroy?.();
    }
  }

  return {
    label: heuristic ? "outreach" : "other",
    isOutreach: heuristic,
    source: "heuristic"
  };
}

function heuristicOutreachDetection(recruiterText, summary) {
  const text = `${recruiterText || ""} ${summary || ""}`.toLowerCase();
  if (!text.trim()) {
    return false;
  }

  const recruiterSignals = [
    /\bhir(?:e|ing)\b/,
    /\brecruit(er|ing)?\b/,
    /\bjob\b/,
    /\brole\b/,
    /\bposition\b/,
    /\bopening\b/,
    /\bopportunit(?:y|ies)\b/,
    /\bheadcount\b/,
    /\binterview\b/,
    /\blet['’]?s\s+(?:chat|connect|talk)\b/,
    /\bchat\s+(?:about|regarding)\b/,
    /\bconnect\s+(?:about|regarding)\b/,
    /\btalent\b/,
    /\bcandidate\b/,
    /\bjoin\s+(?:us|our)\b/,
    /\blooking\s+to\s+(?:hire|fill|bring)\b/,
    /\bstaff(?:ing)?\b/,
    /\bfound(?:ing)?\s+engineer\b/,
    /\bfounders?\b/,
    /\bstartup\b/,
    /\bstealth\b/,
    /\bwould\s+you\s+be\s+open\b/,
    /\bi'?d\s+love\s+to\s+(?:chat|connect)\b/,
    /\bsaw\s+your\s+profile\b/,
    /\breach(?:ing)?\s+out\b/,
    /\bcompensation\b/,
    /\bpackage\b/,
    /\boffer\b/,
    /\bnew\s+headcount\b/
  ];

  return recruiterSignals.some(pattern => pattern.test(text));
}
