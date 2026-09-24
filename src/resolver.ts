import { Attendee } from "./types.js";

export interface FieldPrompt {
  label: string;
  placeholder?: string;
  nameAttr?: string;
  type?: string;
  options?: string[];
  isRequired?: boolean;
}

export function resolveFieldValue(
  prompt: FieldPrompt,
  attendee: Attendee,
  eventContext?: { title: string; url: string }
): { value: string; confidence: number; reason: string } {
  const label = (prompt.label || "").toLowerCase();
  const placeholder = (prompt.placeholder || "").toLowerCase();
  const name = (prompt.nameAttr || "").toLowerCase();
  const combined = `${label} ${placeholder} ${name}`;

  // 1. Check QA Memory first
  if (attendee.qaMemory) {
    for (const [q, a] of Object.entries(attendee.qaMemory)) {
      const qLower = q.toLowerCase();
      if (combined.includes(qLower) || qLower.includes(label)) {
        return { value: a, confidence: 1.0, reason: `QA Memory match for "${q}"` };
      }
    }
  }

  // 2. Select / Dropdown options matching
  if (prompt.options && prompt.options.length > 0) {
    const matchedOption = pickBestDropdownOption(prompt, prompt.options, attendee);
    if (matchedOption) {
      return { value: matchedOption, confidence: 0.95, reason: "Dropdown option matched" };
    }
  }

  // 3. Name fields
  if (/first\s*name|given\s*name/i.test(combined)) {
    return { value: attendee.firstName, confidence: 1.0, reason: "First name" };
  }
  if (/last\s*name|family\s*name|surname/i.test(combined)) {
    return { value: attendee.lastName, confidence: 1.0, reason: "Last name" };
  }
  if (/\bname\b|full\s*name/i.test(combined) && !/company|org|event|project/i.test(combined)) {
    return { value: attendee.name, confidence: 1.0, reason: "Full name" };
  }

  // 4. Email
  if (/\bemail\b|e-mail/i.test(combined) || prompt.type === "email") {
    return { value: attendee.email, confidence: 1.0, reason: "Email" };
  }

  // 5. Phone / Mobile
  if (/phone|mobile|cell|contact\s*num|whatsapp/i.test(combined) || prompt.type === "tel") {
    return { value: attendee.phone, confidence: 1.0, reason: "Phone" };
  }

  // 6. Gender
  if (/gender|sex|성별/i.test(combined)) {
    const g = attendee.gender || "Female";
    if (prompt.options && prompt.options.length > 0) {
      const match = prompt.options.find(o => 
        new RegExp(`\\b${g}\\b|여성|woman`, "i").test(o)
      );
      if (match) return { value: match, confidence: 0.98, reason: "Gender option" };
    }
    return { value: g, confidence: 0.95, reason: "Gender" };
  }

  // 7. Age
  if (/\bage\b|연령|나이/i.test(combined) && !/stage|message|manage/i.test(combined)) {
    const ageStr = String(attendee.age || 28);
    if (prompt.options && prompt.options.length > 0) {
      const match = prompt.options.find(o => 
        /20\s*[-–~]\s*29|25\s*[-–~]\s*34|20s|20대/i.test(o)
      );
      if (match) return { value: match, confidence: 0.98, reason: "Age group" };
    }
    return { value: ageStr, confidence: 0.95, reason: "Age" };
  }

  // 8. Country / Nationality / Location
  if (/country|nationality|residence|국적|location/i.test(combined)) {
    const c = attendee.country || "India";
    if (prompt.options && prompt.options.length > 0) {
      const match = prompt.options.find(o => 
        new RegExp(`\\b(${c}|Singapore|USA|United States|India)\\b`, "i").test(o)
      );
      if (match) return { value: match, confidence: 0.98, reason: "Country option" };
    }
    return { value: c, confidence: 0.95, reason: "Country" };
  }

  // 9. Telegram
  if (/telegram|tg\b/i.test(combined)) {
    return { value: attendee.telegram, confidence: 0.99, reason: "Telegram handle" };
  }

  // 10. Twitter / X
  if (/twitter|x\b|handle/i.test(combined) && !/instagram|facebook|linkedin/i.test(combined)) {
    if (/url|link/i.test(combined)) {
      return { value: attendee.twitter, confidence: 0.98, reason: "Twitter URL" };
    }
    const handle = attendee.twitter.replace(/^https?:\/\/(x\.com|twitter\.com)\//, "@");
    return { value: handle, confidence: 0.98, reason: "Twitter handle" };
  }

  // 11. LinkedIn
  if (/linkedin/i.test(combined)) {
    let url = attendee.linkedin;
    if (!url.startsWith("http")) url = `https://${url}`;
    return { value: url, confidence: 0.99, reason: "LinkedIn URL" };
  }

  // 12. Company / Organization / Fund
  if (/company|organization|organisation|fund|project\s*name|startup|firm/i.test(combined)) {
    return { value: attendee.company, confidence: 0.99, reason: "Company name" };
  }

  // 13. Role / Title / Job
  if (/role|title|designation|job|position|occupation/i.test(combined)) {
    if (prompt.options && prompt.options.length > 0) {
      const match = prompt.options.find(o => 
        /growth|partnership|business development|project|builder|developer|founder/i.test(o)
      );
      if (match) return { value: match, confidence: 0.95, reason: "Role option" };
    }
    return { value: attendee.role, confidence: 0.95, reason: "Job title" };
  }

  // 14. Website / URL / Portfolio
  if (/website|url|link|domain/i.test(combined)) {
    let site = attendee.website;
    if (!site.startsWith("http")) site = `https://${site}`;
    return { value: site, confidence: 0.95, reason: "Website" };
  }

  // 15. Bio / Pitch / Description / About
  if (/bio|pitch|describe|about|introduction|what\s*does\s*your/i.test(combined)) {
    return { value: attendee.pitch, confidence: 0.95, reason: "Company pitch" };
  }

  // 16. Cheque size / Investment ticket
  if (/cheque|ticket\s*size|invest\b|how\s*much|aum/i.test(combined)) {
    if (prompt.options && prompt.options.length > 0) {
      const match = prompt.options.find(o => /<\$10,000|\$10k|angel|project|other/i.test(o));
      if (match) return { value: match, confidence: 0.9, reason: "Investment ticket" };
    }
    return { value: "<$10,000", confidence: 0.9, reason: "Cheque size" };
  }

  // 17. Referral / "Who invited you" / "How did you hear"
  if (/hear|invited|referral|source/i.test(combined)) {
    if (prompt.options && prompt.options.length > 0) {
      const match = prompt.options.find(o => /twitter|x\b|community|friend|online/i.test(o));
      if (match) return { value: match, confidence: 0.9, reason: "Referral option" };
    }
    return { value: "Twitter / Community", confidence: 0.9, reason: "Referral" };
  }

  // 18. Default fallback for required fields (per user request)
  if (prompt.isRequired) {
    if (prompt.options && prompt.options.length > 0) {
      // Pick first safe option or "Other"
      const other = prompt.options.find(o => /other|general|none/i.test(o));
      return { value: other || prompt.options[0], confidence: 0.7, reason: "Fallback dropdown option" };
    }
    return { value: "None", confidence: 0.7, reason: "Fallback for required field" };
  }

  return { value: "", confidence: 0, reason: "No match" };
}

export function pickBestDropdownOption(
  prompt: FieldPrompt,
  options: string[],
  attendee: Attendee
): string | null {
  if (!options || options.length === 0) return null;
  const label = (prompt.label || "").toLowerCase();

  // Role in ecosystem / Category
  if (/role|ecosystem|category|track|profile/i.test(label)) {
    const isFounder = /founder/i.test(attendee.role);
    const pref = isFounder ? ["Founder", "Co-Founder", "Project", "Builder", "Other"] : ["Project", "Developer", "Builder", "Community", "Other"];
    for (const p of pref) {
      const found = options.find(o => o.toLowerCase().includes(p.toLowerCase()));
      if (found) return found;
    }
  }

  // Job Title
  if (/title|job|position/i.test(label)) {
    const pref = ["Head of Growth", "Business Development", "Developer", "Founder", "Contributor", "Other"];
    for (const p of pref) {
      const found = options.find(o => o.toLowerCase().includes(p.toLowerCase()));
      if (found) return found;
    }
  }

  // Cheque size / Investment
  if (/invest|cheque|ticket|fund/i.test(label)) {
    const found = options.find(o => /<\$10,000|\$10k|not\s*an\s*investor|angel|other/i.test(o));
    if (found) return found;
  }

  // Gender
  if (/gender|sex/i.test(label)) {
    const g = attendee.gender || "Female";
    const found = options.find(o => new RegExp(`\\b${g}\\b|woman|female`, "i").test(o));
    if (found) return found;
  }

  // Age group
  if (/age/i.test(label)) {
    const found = options.find(o => /20\s*[-–~]\s*29|25\s*[-–~]\s*34|20s|20대/i.test(o));
    if (found) return found;
  }

  // Country
  if (/country|location/i.test(label)) {
    const c = attendee.country || "India";
    const found = options.find(o => new RegExp(`\\b(${c}|Singapore|USA|United States)\\b`, "i").test(o));
    if (found) return found;
  }

  // Fuzzy match attendee properties against options
  for (const opt of options) {
    const optLower = opt.toLowerCase();
    if (optLower === attendee.company.toLowerCase() || optLower.includes(attendee.company.toLowerCase())) return opt;
    if (optLower === attendee.role.toLowerCase() || optLower.includes(attendee.role.toLowerCase())) return opt;
    if (attendee.persona?.primaryTrack && optLower.includes(attendee.persona.primaryTrack.toLowerCase())) return opt;
  }

  // Fallback to "Other" or option 0
  const other = options.find(o => /other|general|etc/i.test(o));
  return other || options[0];
}
