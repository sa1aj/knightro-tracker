# Knightro photo checker

## Submission and review

The Supabase API validates the signed-in account, campus location, fresh capture token, upload size, and cooldown. It strips metadata and stores an immutable JPEG in the private bucket, then calls the private CPU checker on the teal Vercel project. Classification runs outside the database transaction. Browser-supplied scores or decisions are ignored; retries classify the already stored photo.

- Score at least **0.64576655626297**: publish and award the eligible points.
- Lower score or an unavailable checker: save as **pending**, private to its owner and administrators, with **0 points**. Consume the capture token and normal two-minute cooldown.
- Authorized administrators: turn on Admin Mode, open **Review Sightings**, inspect the photo, then **Approve** or **Remove**. Approval is audited and awards eligible points once. The existing unique bounty claim rule prevents double awards. Pending photos expire after 24 hours and cannot be approved once removed from storage.

The classifier never automatically rejects a photo. The review list prioritizes pending photos and returns up to 100 reports from the past day. Public pins still expire 20 minutes after the original report time; approval does not turn an old report into a fresh sighting.

## Hosting and private access

`frontend/api/photo_check.py` is a Python Vercel Function, reached by Supabase at `/internal/photo-check`. It authenticates `X-Knightro-Proxy-Token` before loading the model or parsing images. There is no browser inference API. The existing `/api/*` Node gateway keeps account cookies and Supabase access server-side.

Set **Production Secrets** on `knightro-tracker-team/knightro-tracker-frontend`:

- `KNIGHTRO_BACKEND_URL`: the existing Supabase API URL.
- `KNIGHTRO_PROXY_TOKEN`: the existing matching Vault proxy token.
- `KNIGHTRO_HF_TOKEN`: a Hugging Face token with read access to the private model. Prefer a dedicated read-only token for this repository when rotating credentials.

The model is **private**, pinned to revision `2e4b13d2ef456a987e20ea2da2b3c376dd993e65` of `Endooou/knightro-checker-20261010-bd35ae7d`. The 6.09 MB ONNX file is downloaded to `/tmp`, checked against SHA-256 `2a0860dc509679664759d71d7c16bfed5aad8c67057f0e7f41b416ec139c6d65`, and cached per process. No training photos, model weights, or tokens are in Git. No recurring training job, paid inference endpoint, or always-on GPU is created. Vercel plan quotas and CPU usage still apply.

The Edge API uses the fixed teal origin, an eight-second model timeout, and no redirects carrying credentials. If that deployment or private model access is unavailable, submissions stay pending. Changing the inference hostname requires updating `_shared/photo-check.ts` and deploying the Edge API. Both approved frontend hostnames share this backend/checker.

Deploy database migrations and `knightro-api` separately from GitHub/Vercel source deployments. The migration wraps the existing service-only RPC, preserving all other application operations, grants, and deny-by-default RLS.

## Calibration evidence

Training: MobileNetV3-small, 196 training photos; 43 validation photos; 42 evaluation photos. Exact duplicate images were removed before splitting. The private dataset revision is `d5650c43a2c4b0c9f3c8cfb875167f9e98ef62f5` of `Endooou/knightro-photos-20261010-bd35ae7d`.

The cutoff was selected from validation scores only: maximize recall with precision at least 95%, at most one false acceptance, and a cutoff at least 0.5. Evaluation photos had already been inspected during the earlier training review; this is not a newly collected independent benchmark.

| Split | Knightro accepted | Knightro sent to review | Non-Knightro accepted | Non-Knightro sent to review |
| --- | ---: | ---: | ---: | ---: |
| Validation | 21 / 26 | 5 / 26 | 1 / 17 | 16 / 17 |
| Evaluation | 21 / 26 | 5 / 26 | 0 / 16 | 16 / 16 |

Calibration uses the production `jpeg-js@0.4.4` nearest resize to max 800 pixels and JPEG quality 65, then Pillow RGB bilinear resize to 224 and ImageNet normalization. ONNX logits match PyTorch on those serving tensors with maximum absolute error below 0.00001. Pillow and the training torchvision uint8 resize have small rounding differences; the cutoff was calibrated on the serving pipeline.

These small samples do not establish production accuracy. The score is not a calibrated probability. Training positives include logos, illustrations, and figurines, so the checker does **not** distinguish the live mascot from other Knightro depictions. More varied real camera photos, difficult negatives, and grouping by source/scene are needed for stronger guarantees.

To replace the model, preserve the original labels, group similar scenes before splitting, select a cutoff on validation only, evaluate a fixed serving pipeline, and update the pinned revision/hash/cutoff together. Do not train on evaluation photos or move training data into the public repository.
