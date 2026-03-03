// ────────────────────────────────────────────────────────────
// LinkedIn Routes
// ────────────────────────────────────────────────────────────
//
// POST /api/linkedin/validate-url  → scrape public profile via Apify
// POST /api/linkedin/upload-zip    → process LinkedIn ZIP export
// ────────────────────────────────────────────────────────────

import { Router, Response } from "express";
import multer from "multer";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { isValidLinkedInUrl, scrapeLinkedInProfile } from "../utils/linkedin/apifyScraper.js";
import { processLinkedInZip } from "../utils/linkedin/zipProcessor.js";

const router = Router();

// Multer config — accept ZIP files up to 50 MB in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = [
            "application/zip",
            "application/x-zip-compressed",
            "application/x-zip",
            "multipart/x-zip",
        ];
        if (allowed.includes(file.mimetype) || file.originalname.endsWith(".zip")) {
            cb(null, true);
        } else {
            cb(new Error("Only .zip files are accepted"));
        }
    },
});

// ── POST /validate-url ────────────────────────────────────

router.post("/validate-url", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { url } = req.body;

        if (!url || typeof url !== "string") {
            res.status(400).json({ error: "LinkedIn profile URL is required" });
            return;
        }

        if (!isValidLinkedInUrl(url)) {
            res.status(400).json({
                error: "Invalid LinkedIn URL. Expected format: https://www.linkedin.com/in/username",
            });
            return;
        }

        // Scrape via Apify
        const result = await scrapeLinkedInProfile(url);

        if (!result.success) {
            const statusCode = result.isPrivate ? 422 : 500;
            res.status(statusCode).json({
                error: result.error,
                isPrivate: result.isPrivate || false,
            });
            return;
        }

        // Save to database
        await prisma.linkedInData.upsert({
            where: { userId: req.userId! },
            update: {
                profile: result.profile as any,
                source: "apify",
            },
            create: {
                userId: req.userId!,
                profile: result.profile as any,
                source: "apify",
            },
        });

        // Update user flags
        await prisma.userAuth.update({
            where: { id: req.userId! },
            data: {
                linkedinImported: true,
                onboardingStage: "linkedin_connected",
            },
        });

        res.json({ success: true, profile: result.profile });
    } catch (err) {
        console.error("[LinkedIn] validate-url error:", err);
        res.status(500).json({ error: "Failed to process LinkedIn profile" });
    }
});

// ── POST /upload-zip ──────────────────────────────────────

router.post(
    "/upload-zip",
    requireAuth,
    upload.single("file"),
    async (req: AuthRequest, res: Response): Promise<void> => {
        try {
            if (!req.file) {
                res.status(400).json({ error: "No ZIP file uploaded" });
                return;
            }

            // Process the ZIP file
            const profile = await processLinkedInZip(req.file.buffer);

            // Save to database
            await prisma.linkedInData.upsert({
                where: { userId: req.userId! },
                update: {
                    profile: profile as any,
                    source: "zip_upload",
                },
                create: {
                    userId: req.userId!,
                    profile: profile as any,
                    source: "zip_upload",
                },
            });

            // Update user flags
            await prisma.userAuth.update({
                where: { id: req.userId! },
                data: {
                    linkedinImported: true,
                    onboardingStage: "linkedin_connected",
                },
            });

            res.json({ success: true, profile });
        } catch (err) {
            console.error("[LinkedIn] upload-zip error:", err);
            res.status(500).json({
                error: (err as Error).message || "Failed to process LinkedIn ZIP file",
            });
        }
    }
);

export default router;
