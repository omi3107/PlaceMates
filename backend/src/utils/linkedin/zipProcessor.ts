// ────────────────────────────────────────────────────────────
// LinkedIn Import — ZIP Upload Processor
// ────────────────────────────────────────────────────────────
//
// Accepts a Buffer (uploaded ZIP file), extracts CSV/XLSX
// files, classifies and parses each one, then runs the
// data mapper to produce a unified LinkedInProfile.
// ────────────────────────────────────────────────────────────

import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import os from "os";

import { classifyFile, isCsv, isExcel } from "./fileFilter.js";
import { parseCsvFile } from "./csvParser.js";
import { parseExcelFile } from "./xlsxParser.js";
import { mapToLinkedInProfile } from "./dataMapper.js";
import type { LinkedInProfile, ParsedFile } from "./types.js";

/**
 * Process a LinkedIn data export ZIP file.
 *
 * @param zipBuffer - The raw ZIP file as a Buffer
 * @returns The unified LinkedInProfile
 */
export async function processLinkedInZip(zipBuffer: Buffer): Promise<LinkedInProfile> {
    // Create a temporary directory for extraction
    const tmpDir = path.join(os.tmpdir(), `linkedin-import-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        // Extract ZIP contents
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(tmpDir, true);

        // Collect all files recursively
        const allFiles = collectFiles(tmpDir);

        // Classify, parse, and collect ParsedFile entries
        const parsedFiles: ParsedFile[] = [];

        for (const filePath of allFiles) {
            const category = classifyFile(filePath);
            if (!category) continue; // skip unrecognized files

            let rows: Record<string, string>[] = [];

            if (isCsv(filePath)) {
                rows = await parseCsvFile(filePath);
            } else if (isExcel(filePath)) {
                rows = parseExcelFile(filePath);
            }

            if (rows.length > 0) {
                parsedFiles.push({ category, rows });
            }
        }

        if (parsedFiles.length === 0) {
            throw new Error(
                "No recognizable LinkedIn data files found in the ZIP. " +
                "Please upload the ZIP file downloaded from LinkedIn's 'Get a copy of your data' feature."
            );
        }

        // Map to unified profile
        const profile = mapToLinkedInProfile(parsedFiles);

        return profile;
    } finally {
        // Clean up temp directory
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            console.warn("[LinkedIn ZIP] Failed to clean up temp directory:", tmpDir);
        }
    }
}

/**
 * Recursively collect all file paths in a directory.
 */
function collectFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectFiles(fullPath));
        } else {
            results.push(fullPath);
        }
    }

    return results;
}
