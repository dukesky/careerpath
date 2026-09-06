/**
 * What the panel says while a run has produced nothing to show yet.
 *
 * The bar every line here has to clear: it must be worth reading by someone
 * who is job-hunting and already knows the basics. Filler ("tailor your
 * resume to the job") makes the wait feel longer, not shorter, because it
 * confirms the panel is stalling rather than informing. Each tip is one
 * concrete, actionable claim — a number, a threshold, or a specific move.
 *
 * The deck is deliberately deeper than a wait is long. A run reaches its
 * first paint in well under a minute, so at one card per eight seconds no
 * user should ever see the deck loop; the length is what buys that, and
 * WaitingTips.test.tsx pins a floor on it.
 *
 * Nothing here is personalised, and nothing here reads the user's resume or
 * the posting. These are static strings — no run data reaches this file, and
 * none should: a "tip" derived from a half-arrived analysis would be advice
 * from a model that has not finished thinking.
 */

export type TipCategory = "applying" | "resume" | "interview" | "follow-up";

export interface Tip {
  category: TipCategory;
  text: string;
}

/** Display names for the category tag, which is a label and not a slug. */
export const TIP_CATEGORY_LABEL: Record<TipCategory, string> = {
  applying: "Applying",
  resume: "Resume",
  interview: "Interview",
  "follow-up": "Follow-up",
};

export const TIPS: Tip[] = [
  // --- applying ------------------------------------------------------------
  {
    category: "applying",
    text: "Apply within 48 hours of a posting going live — early applications get disproportionate recruiter attention.",
  },
  {
    category: "applying",
    text: "Referrals convert far better than cold applications. Check whether anyone in your network works there before you hit submit.",
  },
  {
    category: "applying",
    text: "A job description is a wish list, not a checklist. Meeting most of the must-haves is usually enough to be worth an application.",
  },
  {
    category: "applying",
    text: "Applying to five roles you actually fit beats applying to fifty you don't. Volume without fit mostly buys you rejections.",
  },
  {
    category: "applying",
    text: "Track every application in one place — company, date, contact, and version sent. You will need it when a recruiter calls three weeks later.",
  },
  {
    category: "applying",
    text: "If a posting has been up for more than a month, ask about the role's status before investing in a long take-home.",
  },

  // --- resume --------------------------------------------------------------
  {
    category: "resume",
    text: "Recruiters spend seconds on a first pass. Your top bullet under each role should be the one you'd say out loud in an interview.",
  },
  {
    category: "resume",
    text: "Numbers beat adjectives: “cut deploy time from 22 to 6 minutes” outworks “significantly improved deployments”.",
  },
  {
    category: "resume",
    text: "Lead each bullet with what you did, not with the team's mission. “Led”, “built” and “shipped” say more than “responsible for”.",
  },
  {
    category: "resume",
    text: "Mirror the posting's own vocabulary where it's honest to. A screener searching for “Kubernetes” will not find “container orchestration”.",
  },
  {
    category: "resume",
    text: "One page for under ten years of experience, two beyond it. A third page is almost always the first two written less carefully.",
  },
  {
    category: "resume",
    text: "Drop the skills you'd dread being asked about. Everything on the page is fair game for an interviewer.",
  },
  {
    category: "resume",
    text: "Send a PDF unless the posting asks otherwise — it is the only format that reaches the reader looking the way you left it.",
  },

  // --- interview -----------------------------------------------------------
  {
    category: "interview",
    text: "Prepare three stories in STAR form (situation, task, action, result). Most behavioural questions are one of them wearing a costume.",
  },
  {
    category: "interview",
    text: "At the end, ask the interviewer what surprised them most in their first months. It reads as judgement, not flattery.",
  },
  {
    category: "interview",
    text: "Say your reasoning out loud in a technical round. A silent candidate who arrives at the answer scores below one who thinks in the open.",
  },
  {
    category: "interview",
    text: "Rehearse the first two minutes of “tell me about yourself”. It sets the frame for everything asked after it.",
  },
  {
    category: "interview",
    text: "Have one honest failure ready, with what you changed afterwards. “I work too hard” costs you the credibility the rest of the answer needs.",
  },
  {
    category: "interview",
    text: "Re-read your own resume the morning of the interview. You will be asked about a project you last thought about two years ago.",
  },
  {
    category: "interview",
    text: "Let the recruiter name a number first. When you can't avoid going first, give a range grounded in the market, not in your last salary.",
  },

  // --- follow-up -----------------------------------------------------------
  {
    category: "follow-up",
    text: "Send a thank-you note within 24 hours that references one specific moment from the conversation.",
  },
  {
    category: "follow-up",
    text: "If they gave you a decision date, follow up one working day after it — not before. Chasing early reads as anxiety, not interest.",
  },
  {
    category: "follow-up",
    text: "Ask for feedback after a rejection, briefly and without arguing. A surprising number of hiring managers answer, and some remember you next cycle.",
  },
  {
    category: "follow-up",
    text: "Keep applying while you wait on a final round. An offer negotiated against a real alternative is a different conversation.",
  },
];
