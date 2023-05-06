// imports
import express from "express";
import { MulterError } from "multer";
import { getVideoDurationInSeconds } from "get-video-duration";
import { upload, deleteFile } from "../models/multerSetup";
import { s3_download, s3_upload, s3_delete } from "../models/s3";
import { MulterFileType, VideoType, PeekoRequest } from "../types";
import Video from "../models/video";
import { checkVideoExists } from "../middleware/checkResourceExists";
import { requireAuth } from "../middleware/authentication";

// create router
const router = express.Router();

/**
 * @post
 *      POST request to upload a video to s3 and db
 */
router.post("/uploadVideo", requireAuth, async (req: PeekoRequest, res) => {
    upload(req, res, async (err) => {
        if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
                suucess: false,
                error: "Video file size must not exceed 100 MB",
            });
        } else if (err) {
            return res.status(400).json({
                success: false,
                error: err.message,
            });
        }

        // if no errors
        // validate file existence
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: "Video file not found",
            });
        }

        // destructure
        const uploaderId = req.currentUser!._id;
        const uploaderUsername = req.currentUser!.username;
        const videoFile: MulterFileType = req.file;

        try {
            // validate video file duration
            const duration = await getVideoDurationInSeconds(videoFile.path);
            if (duration > 300) {
                await deleteFile(videoFile.path);
                return res.status(400).json({
                    success: false,
                    error: "Video duration must not exceed 5 minutes",
                });
            }

            // upload to S3
            const s3_result = await s3_upload(videoFile);
            await deleteFile(videoFile.path);

            // create video object structure
            const videoObject = {
                uploaderId,
                uploaderUsername,
                videoKey: s3_result.Key,
            };

            // upload video data to db
            const videoDocument: VideoType = await Video.create(videoObject);

            // return result to client
            res.status(200).json({
                success: true,
                videoDocument,
            });
        } catch (err: any) {
            console.error(err);
            return res.status(400).json({
                success: false,
                error: err.message,
            });
        }
    });
});

/**
 * @get
 *      GET request to get a specific video file through a provided video key
 */
router.get("/streamVideo/:videoKey", checkVideoExists, async (req, res) => {
    // destructure
    const { videoKey } = req.params;

    try {
        // get video from s3
        const readStream = s3_download(videoKey);
        readStream.pipe(res);
    } catch (err: any) {
        console.error(err);
        res.status(400).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * @get
 *      GET request to get a specific video data through a provided video key
 */
router.get(
    "/getVideo/:videoKey",
    checkVideoExists,
    async (req: PeekoRequest, res) => {
        try {
            // get video from db
            const videoDocument = req.resource as VideoType;

            res.status(200).json({
                success: true,
                videoDocument,
            });
        } catch (err: any) {
            console.error(err);
            res.status(400).json({
                success: false,
                error: err.message,
            });
        }
    }
);

/**
 * @post
 *      POST request to get random video data from the database.
 *      It is a POST method because a body is needed to pass data.
 */
router.post("/getVideos", requireAuth, async (req, res) => {
    // destructure
    const count = parseInt(req.body.count as string) || 10;
    const viewed: string[] = req.body.viewed || [];

    try {
        /**
         * Use MongoDB $match aggregation stage to exclude
         * previously watched videos from the pipeline.
         *
         * Use MongoDB $sample aggregation stage to get a
         * #count number of randomly selected videos.
         *
         * Use MongoDB $group aggregation stage to make sure
         * we don't get duplicate documents.
         */
        const videoDocuments: VideoType[] = await Video.aggregate([
            { $match: { videoKey: { $nin: viewed } } },
            { $sample: { size: count } },
            { $group: { _id: "$_id", doc: { $first: "$$ROOT" } } },
            { $replaceWith: "$doc" },
        ]);

        // return result
        return res.status(200).json({
            success: true,
            videoDocuments,
        });
    } catch (err: any) {
        console.error(err);
        res.status(400).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * @delete
 *      DELETE request to delete a video from s3 and db
 */
router.delete(
    "/deleteVideo/:videoKey",
    requireAuth,
    checkVideoExists,
    async (req: PeekoRequest, res) => {
        // destructure
        const videoDocument = req.resource as VideoType;
        const videoKey = req.params.videoKey as string;

        try {
            // if deleter is not publisher
            if (req.currentUser!._id !== videoDocument.uploaderId) {
                return res.status(400).json({
                    success: false,
                    error: "Unauthorized Action",
                });
            }

            // delete video document from db
            const deletedVideoDocument: VideoType | null =
                await Video.findOneAndDelete({ videoKey });

            // delete video file from s3
            await s3_delete(videoKey);

            // return response
            res.status(200).json({
                success: true,
                deletedVideoDocument,
            });
        } catch (err: any) {
            console.error(err);
            res.status(400).json({
                success: false,
                error: err.message,
            });
        }
    }
);

// export router
export default router;
