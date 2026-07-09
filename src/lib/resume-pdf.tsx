import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  pdf,
} from "@react-pdf/renderer";
import type { ParsedResume } from "./resume";

// Built-in PDF fonts (Helvetica) — no external font files to bundle.
const styles = StyleSheet.create({
  page: {
    paddingVertical: 42,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#1e293b",
    lineHeight: 1.4,
  },
  name: { fontSize: 20, fontFamily: "Helvetica-Bold", color: "#0f172a" },
  contact: { fontSize: 9, color: "#64748b", marginTop: 3 },
  summary: { marginTop: 4 },
  sectionTitle: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: "#334155",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 16,
    marginBottom: 5,
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  entry: { marginBottom: 8 },
  entryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  entryTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: "#0f172a" },
  entryDates: { fontSize: 9, color: "#64748b" },
  entryDesc: { marginTop: 1 },
  bulletRow: { flexDirection: "row", marginTop: 2, paddingRight: 6 },
  bulletDot: { width: 10 },
  bulletText: { flex: 1 },
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
    .join("  ·  ");

  return (
    <Document
      title={[c.name, "Resume"].filter(Boolean).join(" — ")}
      author={c.name || "career-path"}
    >
      <Page size="A4" style={styles.page}>
        {c.name ? <Text style={styles.name}>{c.name}</Text> : null}
        {contactLine ? <Text style={styles.contact}>{contactLine}</Text> : null}

        {resume.summary ? (
          <View>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text style={styles.summary}>{resume.summary}</Text>
          </View>
        ) : null}

        {resume.experience.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Experience</Text>
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
            <Text style={styles.sectionTitle}>Projects</Text>
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
            <Text style={styles.sectionTitle}>Skills</Text>
            <Text>{resume.skills.join("  ·  ")}</Text>
          </View>
        ) : null}

        {resume.education.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Education</Text>
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
