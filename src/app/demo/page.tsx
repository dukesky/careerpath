"use client";

// A no-backend preview of the results UI (Preview / Diff / Edit / Export PDF)
// with sample data — for eyeballing the UI without a live Analyze & Tailor run.
// Safe to delete once the results view has been reviewed.

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ResultsView } from "@/components/ResultsView";
import type { ParsedResume } from "@/lib/resume";
import type { GapAnalysis, TailorResult } from "@/lib/analysis";

const ORIGINAL: ParsedResume = {
  contact: {
    name: "Jane Doe",
    email: "jane.doe@example.com",
    phone: "(555) 123-4567",
    location: "San Francisco, CA",
    links: ["linkedin.com/in/janedoe", "github.com/janedoe"],
  },
  summary:
    "Software engineer with 6 years of experience building web applications. Worked on backend services and some data pipelines.",
  experience: [
    {
      company: "Acme Corp",
      title: "Software Engineer",
      dates: "2020 – Present",
      bullets: [
        "Built and maintained backend services in Python and Go.",
        "Worked on a data pipeline that processed user events.",
        "Helped migrate the codebase to TypeScript.",
      ],
    },
    {
      company: "Startup Inc",
      title: "Junior Developer",
      dates: "2018 – 2020",
      bullets: [
        "Developed features for the main web app.",
        "Fixed bugs and wrote tests.",
      ],
    },
  ],
  projects: [
    {
      name: "Side Project: ReqStream",
      description: "A hobby service for streaming request logs.",
      bullets: ["Handles about 10k requests per second."],
    },
  ],
  skills: ["Python", "Go", "TypeScript", "SQL", "Docker"],
  education: [
    { school: "State University", degree: "B.S. Computer Science", dates: "2018" },
  ],
};

const TAILORED: TailorResult = {
  resume: {
    ...ORIGINAL,
    summary:
      "Machine learning engineer with 6 years building production ML systems and high-throughput data pipelines. Specialized in Python, distributed systems, and real-time inference.",
    experience: [
      {
        company: "Acme Corp",
        title: "Software Engineer",
        dates: "2020 – Present",
        bullets: [
          "Designed and operated production backend services in Python and Go serving millions of requests daily.",
          "Built a real-time data pipeline processing 10k+ user events per second to power ML features.",
          "Led the migration of the core codebase to TypeScript, improving reliability.",
        ],
      },
      ORIGINAL.experience[1],
    ],
    skills: [
      "Python",
      "Go",
      "TypeScript",
      "SQL",
      "Docker",
      "Distributed Systems",
      "Machine Learning",
    ],
  },
  change_log: [
    {
      section: "Summary",
      original:
        "Software engineer with 6 years of experience building web applications.",
      revised:
        "Machine learning engineer with 6 years building production ML systems and high-throughput data pipelines.",
      reason:
        "Foregrounds ML and pipeline experience to match the role's focus.",
    },
    {
      section: "Experience — Acme Corp",
      original: "Worked on a data pipeline that processed user events.",
      revised:
        "Built a real-time data pipeline processing 10k+ user events per second to power ML features.",
      reason: "Quantifies scale (from your ReqStream project) and ties to ML.",
    },
    {
      section: "Skills",
      original: "Python, Go, TypeScript, SQL, Docker",
      revised: "…added Distributed Systems, Machine Learning",
      reason: "Surfaces role-relevant keywords already evidenced in your work.",
    },
  ],
  projected_match_score: 91,
};

const ANALYSIS: GapAnalysis = {
  overall_match_score: 78,
  rationale:
    "Strong backend and data-pipeline foundation that maps well to this ML engineering role. The main gaps are explicit ML framework experience and a formal ML background, both of which can be partially addressed by reframing existing work.",
  requirements_matrix: [
    {
      requirement: "5+ years software engineering",
      kind: "must_have",
      status: "met",
      evidence: "6 years across Acme Corp and Startup Inc.",
      suggestion: "Keep front and center in the summary.",
    },
    {
      requirement: "Production ML systems",
      kind: "must_have",
      status: "partially_met",
      evidence: "Built ML-adjacent data pipelines, but no explicit model work.",
      suggestion: "Frame the event pipeline as ML-feature infrastructure.",
    },
    {
      requirement: "PyTorch / TensorFlow",
      kind: "must_have",
      status: "missing",
      evidence: "Not present in resume or extra info.",
      suggestion: "Only claim if true; otherwise note transferable skills.",
    },
    {
      requirement: "Distributed systems",
      kind: "nice_to_have",
      status: "met",
      evidence: "High-throughput services and a 10k req/s side project.",
      suggestion: "Quantify scale explicitly.",
    },
  ],
  strengths: [
    "6 years of shipping backend services in Python and Go",
    "Real-time data pipeline experience at meaningful scale",
    "Demonstrated ownership (led TypeScript migration)",
    "Side project showing systems depth (10k req/s)",
    "Strong fundamentals across SQL, Docker, and distributed systems",
  ],
  gaps: [
    {
      gap: "No hands-on deep-learning framework experience (PyTorch/TensorFlow)",
      mitigation:
        "Be honest about this. Emphasize transferable data/infra skills and any coursework or self-study rather than overclaiming.",
    },
    {
      gap: "ML work is infrastructure-adjacent, not modeling",
      mitigation:
        "Reframe pipeline work as ML-feature enablement, which is accurate and relevant.",
    },
  ],
};

export default function DemoPage() {
  const [tailored, setTailored] = useState<TailorResult>(TAILORED);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
          <Logo />
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
            Demo — sample data, no API calls
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <ResultsView
          analysis={ANALYSIS}
          tailored={tailored}
          originalResume={ORIGINAL}
          company="Adobe"
          onTailoredResumeChange={(next) =>
            setTailored((prev) => ({ ...prev, resume: next }))
          }
          onBack={() => setTailored(TAILORED)}
        />
        <div className="mt-6 text-center text-sm text-slate-500">
          <Link href="/app" className="font-medium text-indigo-600 hover:underline">
            Go to the real workspace →
          </Link>
        </div>
      </main>
    </div>
  );
}
