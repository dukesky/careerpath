import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center gap-2.5 ${className}`}
    >
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#A855F7] text-white shadow-[0_6px_16px_-4px_rgba(124,58,237,0.5)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-[18px] w-[18px]"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.4a1.5 1.5 0 0 1 1.06.44l3.1 3.1A1.5 1.5 0 0 1 18.5 7.6V19.5A1.5 1.5 0 0 1 17 21H7.5A1.5 1.5 0 0 1 6 19.5v-15Z" />
          <path d="M9 12.6l2 2 4-4.5" />
        </svg>
      </span>
      <span className="font-display text-[21px] font-bold tracking-tight text-[#0E1220]">
        career<span className="text-[#7C3AED]">-path</span>
      </span>
    </Link>
  );
}
