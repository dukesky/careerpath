import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center gap-2 font-semibold text-slate-900 ${className}`}
    >
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-4 w-4"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 19V5a1 1 0 0 1 1-1h9l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z" />
          <path d="M14 4v4h4" />
          <path d="M8.5 13.5 11 16l4.5-5" />
        </svg>
      </span>
      <span className="text-lg tracking-tight">
        career<span className="text-indigo-600">-path</span>
      </span>
    </Link>
  );
}
