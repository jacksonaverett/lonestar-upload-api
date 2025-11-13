import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";

export const config = {
  api: {
    bodyParser: false, // we handle multipart form data ourselves
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("Form parse error:", err);
      return res.status(500).json({
        error: "Error parsing the form",
        detail: err.message || String(err),
      });
    }

    let file = files.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // 🔧 Normalize in case formidable returns an array
    if (Array.isArray(file)) {
      file = file[0];
    }

    // Fallback filename if originalFilename is missing
    const originalName =
      file.originalFilename || file.newFilename || `upload-${Date.now()}`;
    const cleanFileName = originalName.replace(/\s+/g, "_");
    const encodedFileName = encodeURIComponent(cleanFileName);

    // Read env vars (set in Vercel)
    const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
    const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST;
    const BUNNY_STORAGE_PASSWORD = process.env.BUNNY_STORAGE_PASSWORD;
    const BUNNY_PULL_ZONE_HOST = process.env.BUNNY_PULL_ZONE_HOST;
    const BUNNY_UPLOAD_FOLDER =
      process.env.BUNNY_UPLOAD_FOLDER || "1_APPEAL_REQUEST_UPLOADS";
    const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

    if (
      !BUNNY_STORAGE_ZONE ||
      !BUNNY_STORAGE_HOST ||
      !BUNNY_STORAGE_PASSWORD ||
      !BUNNY_PULL_ZONE_HOST
    ) {
      console.error("Missing Bunny env vars", {
        BUNNY_STORAGE_ZONE,
        BUNNY_STORAGE_HOST,
        hasPassword: !!BUNNY_STORAGE_PASSWORD,
        BUNNY_PULL_ZONE_HOST,
      });
      return res.status(500).json({
        error: "Server misconfigured",
        detail: "Missing one or more Bunny env vars",
      });
    }

    try {
      // 1) Upload to Bunny Storage
      const bunnyUploadUrl = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_ZONE}/${BUNNY_UPLOAD_FOLDER}/${encodedFileName}`;
      console.log("Uploading to Bunny:", bunnyUploadUrl);

      const fileStream = fs.createReadStream(file.filepath);

      const bunnyResponse = await fetch(bunnyUploadUrl, {
        method: "PUT",
        headers: {
          AccessKey: BUNNY_STORAGE_PASSWORD,
          "Content-Type": "application/octet-stream",
        },
        body: fileStream,
      });

      if (!bunnyResponse.ok) {
        const errorText = await bunnyResponse.text();
        console.error("Bunny upload failed:", bunnyResponse.status, errorText);
        return res.status(500).json({
          error: "Upload failed",
          status: bunnyResponse.status,
          detail: errorText,
        });
      }

      // 2) Build public CDN URL
      const fileUrl = `https://${BUNNY_PULL_ZONE_HOST}/${BUNNY_UPLOAD_FOLDER}/${encodedFileName}`;

      // 3) Optional: send to Zapier (for Notion)
      if (ZAPIER_WEBHOOK_URL) {
        const payload = {
          name: fields.name || "",
          email: fields.email || "",
          phone: fields.phone || "",
          notes: fields.notes || "",
          file_url: fileUrl,
        };

        try {
          const zapRes = await fetch(ZAPIER_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!zapRes.ok) {
            const zapText = await zapRes.text();
            console.error("Zapier webhook error:", zapRes.status, zapText);
          }
        } catch (zapErr) {
          console.error("Zapier webhook exception:", zapErr);
        }
      }

      return res.status(200).json({ success: true, fileUrl });
    } catch (uploadError) {
      console.error("Upload error:", uploadError);
      return res.status(500).json({
        error: "Server error",
        detail: uploadError.message || String(uploadError),
      });
    }
  });
}
