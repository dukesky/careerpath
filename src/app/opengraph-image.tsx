import { ImageResponse } from "next/og";

// Branded 1200×630 share card, rendered on demand by Next.js. Used for both
// Open Graph (Facebook/LinkedIn) and Twitter large-image cards. No binary asset
// to maintain — the design lives here in code.
export const alt =
  "career-path — Tailor your resume to any job description";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #0E1220 0%, #1B1436 55%, #2A1150 100%)",
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "linear-gradient(135deg, #7C3AED, #C026D3)",
            }}
          />
          <div style={{ fontSize: 30, fontWeight: 700, color: "#E7E3F5" }}>
            career-path
          </div>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              color: "white",
              letterSpacing: "-0.02em",
              display: "flex",
              flexWrap: "wrap",
            }}
          >
            Tailor your resume to any&nbsp;
            <span
              style={{
                background: "linear-gradient(90deg, #A78BFA, #E879F9)",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              job description
            </span>
          </div>
          <div style={{ fontSize: 30, color: "#B7B3C9", lineHeight: 1.4 }}>
            Rewritten for the role, never fabricated. Nothing stored. Open source.
          </div>
        </div>

        {/* Footer row (dots drawn as divs to avoid font-glyph downloads) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 24,
            color: "#8E8AA6",
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              background: "#22C063",
            }}
          />
          <span>Private by design</span>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: "#3A3A52",
            }}
          />
          <span>github.com/dukesky/careerpath</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
