// ────────────────────────────────────────────────────────────
// LinkedIn Import — Apify Public Profile Scraper
// ────────────────────────────────────────────────────────────
//
// Validates a LinkedIn URL, calls the Apify LinkedIn Profile
// Enrichment actor (anchor~linkedin-profile-enrichment), and
// returns structured profile data.
// Falls back with a clear error when profile is private.
// ────────────────────────────────────────────────────────────

import type { LinkedInProfile } from "./types.js";

const LINKEDIN_URL_REGEX = /^https?:\/\/(www\.)?linkedin\.com\/in\/[\w-]+\/?$/;

/**
 * Validate a LinkedIn profile URL format.
 */
export function isValidLinkedInUrl(url: string): boolean {
    return LINKEDIN_URL_REGEX.test(url.trim());
}

/**
 * Result from the Apify scrape attempt.
 */
export interface ApifyScrapeResult {
    success: boolean;
    profile?: LinkedInProfile;
    isPrivate?: boolean;
    error?: string;
}

/**
 * Scrape a public LinkedIn profile via the Apify actor.
 *
 * Uses the "anchor~linkedin-profile-enrichment" actor.
 * If the profile is private or inaccessible, returns { success: false, isPrivate: true }.
 */
export async function scrapeLinkedInProfile(url: string): Promise<ApifyScrapeResult> {
    const apiToken = process.env.APIFY_API_TOKEN;

    if (!apiToken) {
        return {
            success: false,
            error: "APIFY_API_TOKEN is not configured on the server",
        };
    }

    if (!isValidLinkedInUrl(url)) {
        return {
            success: false,
            error: "Invalid LinkedIn profile URL. Expected format: https://www.linkedin.com/in/username",
        };
    }

    try {
        // Run the Apify actor synchronously (waits for result)
        const actorId = "anchor~linkedin-profile-enrichment";
        const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apiToken}`;

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                startUrls: [{ url: url.trim() }],
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error("[Apify] API error:", response.status, errorBody);
            return {
                success: false,
                error: `Apify API returned status ${response.status}`,
            };
        }

        const results: any[] = await response.json();

        if (!results || results.length === 0) {
            return {
                success: false,
                isPrivate: true,
                error: "No data returned. The profile may be private or the URL is invalid.",
            };
        }

        const raw = results[0];

        // Log raw data for debugging
        console.log("[Apify] Raw response:", JSON.stringify(raw, null, 2));

        // Check for Apify actor-level errors (e.g. monthly run limits)
        if (raw.errorMessage) {
            console.error("[Apify] Actor error:", raw.errorMessage);
            return {
                success: false,
                error: `Apify scraper error: ${raw.errorMessage}`,
            };
        }

        // Check for private profile indicators
        if (raw.error || raw.isPrivate || (!raw.first_name && !raw.full_name && !raw.headline)) {
            return {
                success: false,
                isPrivate: true,
                error: "This LinkedIn profile appears to be private. Please use the ZIP upload option instead.",
            };
        }

        // Map Apify data to our LinkedInProfile schema
        const profile = mapApifyToProfile(raw);

        return { success: true, profile };
    } catch (err) {
        console.error("[Apify] Scrape error:", err);
        return {
            success: false,
            error: `Failed to scrape profile: ${(err as Error).message}`,
        };
    }
}

// ── Map Apify raw output → LinkedInProfile ────────────────
// Field names from anchor~linkedin-profile-enrichment actor:
// full_name, first_name, last_name, headline, summary,
// country, city, profile_pic_url, public_identifier,
// skills (string[]), experiences, education, certifications, etc.

function mapApifyToProfile(raw: any): LinkedInProfile {
    const firstName = raw.first_name || raw.full_name?.split(" ")[0] || "";
    const lastName = raw.last_name || raw.full_name?.split(" ").slice(1).join(" ") || "";

    // Build location from city + country
    const locationParts = [raw.city, raw.country].filter(Boolean);
    const location = locationParts.join(", ");

    return {
        personal: {
            firstName,
            lastName,
            headline: raw.headline || "",
            location: location || "",
            industry: raw.industry || "",
            profileUrl: raw.url || raw.linkedin_url || "",
        },
        about: raw.summary || raw.about || "",
        contact: {
            emails: raw.personal_emails || [],
            phones: raw.personal_numbers || [],
        },
        experience: (raw.experiences || []).map((exp: any) => ({
            companyName: exp.company || exp.companyName || "",
            title: exp.title || exp.role || "",
            location: exp.location || undefined,
            startDate: exp.starts_at || exp.startDate || undefined,
            endDate: exp.ends_at || exp.endDate || undefined,
            description: exp.description || undefined,
        })),
        education: (raw.education || []).map((edu: any) => ({
            schoolName: edu.school || edu.schoolName || edu.institution || "",
            degree: edu.degree_name || edu.degree || undefined,
            fieldOfStudy: edu.field_of_study || edu.fieldOfStudy || undefined,
            startDate: edu.starts_at || edu.startDate || undefined,
            endDate: edu.ends_at || edu.endDate || undefined,
            activities: edu.activities || undefined,
            notes: edu.notes || undefined,
        })),
        skills: (raw.skills || []).map((s: any) => ({
            name: typeof s === "string" ? s : s.name || s.skill || "",
        })).filter((s: any) => s.name),
        projects: (raw.projects || []).map((p: any) => ({
            title: p.title || p.name || "",
            description: p.description || undefined,
            url: p.url || undefined,
            startDate: p.startDate || undefined,
            endDate: p.endDate || undefined,
        })),
        certifications: (raw.certifications || []).map((c: any) => ({
            name: c.name || c.title || "",
            authority: c.authority || c.issuer || undefined,
            licenseNumber: c.licenseNumber || undefined,
            url: c.url || undefined,
            startDate: c.startDate || undefined,
            endDate: c.endDate || undefined,
        })),
        awards: (raw.honors || raw.awards || []).map((a: any) => ({
            title: a.title || a.name || "",
            issuer: a.issuer || undefined,
            issueDate: a.issueDate || a.date || undefined,
            description: a.description || undefined,
        })),
        media: [],
    };
}
