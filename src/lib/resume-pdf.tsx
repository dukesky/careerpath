import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  pdf,
} from "@react-pdf/renderer";
import type { ParsedResume } from "./resume";

// Disable automatic hyphenation so long tokens (URLs, "API Gateway)") never
// break mid-word with an ugly trailing dash.
Font.registerHyphenationCallback((word) => [word]);

// Classic one-page serif resume. NOTE: never set `lineHeight` on the page —
// react-pdf compounds it with per-Text lineHeight on direct children (loose
// paragraphs). Set leading per element instead.
const styles = StyleSheet.create({
  page: {
    paddingTop: 34,
    paddingBottom: 32,
    paddingHorizontal: 44,
    fontFamily: "Times-Roman",
    fontSize: 9.5,
    color: "#1a1a1a",
  },
  name: {
    fontSize: 18,
    fontFamily: "Times-Bold",
    textAlign: "center",
    color: "#111",
  },
  contact: { fontSize: 9, textAlign: "center", color: "#333", marginTop: 3 },
  section: {
    fontSize: 10,
    fontFamily: "Times-Bold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 10,
    marginBottom: 3,
    paddingBottom: 1.5,
    borderBottomWidth: 0.75,
    borderBottomColor: "#333",
  },
  paragraph: { fontSize: 9.5, lineHeight: 1.3 },
  entry: { marginBottom: 4.5 },
  entryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  entryTitle: { fontSize: 9.5, fontFamily: "Times-Bold" },
  entryDates: { fontSize: 9, color: "#444" },
  entryDesc: { fontSize: 9.5, lineHeight: 1.3, marginTop: 1 },
  bulletRow: { flexDirection: "row", marginTop: 1.5, paddingRight: 2 },
  bulletDot: { width: 9, fontSize: 9 },
  bulletText: { flex: 1, fontSize: 9.3, lineHeight: 1.3 },
  skills: { fontSize: 9.3, lineHeight: 1.35 },
});

function Bullets({ items }: { items: string[] }) {
  return (
    <>
      {items.map((b, i) => (
        <View key={i} style={styles.bulletRow} wrap={false}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{b}</Text>
        </View>
      ))}
    </>
  );
}

function ResumePdfDoc({ resume }: { resume: ParsedResume }) {
  const c = resume.contact;
  const contactLine = [c.email, c.phone, c.location, ...c.links]
    .filter(Boolean)
    .join("   |   ");

  return (
    <Document
      title={[c.name, "Resume"].filter(Boolean).join(" — ")}
      author={c.name || "career-path"}
    >
      <Page size="LETTER" style={styles.page}>
        {c.name ? <Text style={styles.name}>{c.name}</Text> : null}
        {contactLine ? <Text style={styles.contact}>{contactLine}</Text> : null}

        {resume.summary ? (
          <View>
            <Text style={styles.section}>Summary</Text>
            <Text style={styles.paragraph}>{resume.summary}</Text>
          </View>
        ) : null}

        {resume.experience.length > 0 ? (
          <View>
            <Text style={styles.section}>Experience</Text>
            {resume.experience.map((e, i) => (
              <View key={i} style={styles.entry} wrap={false}>
                <View style={styles.entryHeader}>
                  <Text style={styles.entryTitle}>
                    {[e.title, e.company].filter(Boolean).join(" — ")}
                  </Text>
                  {e.dates ? (
                    <Text style={styles.entryDates}>{e.dates}</Text>
                  ) : null}
                </View>
                <Bullets items={e.bullets} />
              </View>
            ))}
          </View>
        ) : null}

        {resume.projects.length > 0 ? (
          <View>
            <Text style={styles.section}>Projects</Text>
            {resume.projects.map((p, i) => (
              <View key={i} style={styles.entry} wrap={false}>
                <Text style={styles.entryTitle}>{p.name}</Text>
                {p.description ? (
                  <Text style={styles.entryDesc}>{p.description}</Text>
                ) : null}
                <Bullets items={p.bullets} />
              </View>
            ))}
          </View>
        ) : null}

        {resume.skills.length > 0 ? (
          <View>
            <Text style={styles.section}>Skills</Text>
            <Text style={styles.skills}>{resume.skills.join("  ·  ")}</Text>
          </View>
        ) : null}

        {resume.education.length > 0 ? (
          <View>
            <Text style={styles.section}>Education</Text>
            {resume.education.map((ed, i) => (
              <View key={i} style={styles.entryHeader} wrap={false}>
                <Text style={styles.entryTitle}>
                  {[ed.degree, ed.school].filter(Boolean).join(" — ")}
                </Text>
                {ed.dates ? (
                  <Text style={styles.entryDates}>{ed.dates}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

/** Build a filename like `Jane_Doe_Adobe_Resume.pdf`. */
export function resumePdfFilename(
  candidateName: string,
  company: string,
): string {
  const slug = (s: string) =>
    s
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const parts = [slug(candidateName), slug(company), "Resume"].filter(Boolean);
  return `${parts.join("_")}.pdf`;
}

export async function generateResumePdf(resume: ParsedResume): Promise<Blob> {
  return pdf(<ResumePdfDoc resume={resume} />).toBlob();
}
