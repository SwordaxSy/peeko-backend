import { Schema, model } from "mongoose";

const commentSchema = new Schema(
    {
        commentorId: {
            type: String,
            required: true,
            trim: true,
        },
        commentorUsername: {
            type: String,
            required: true,
            trim: true,
        },
        comment: {
            type: String,
            required: true,
            trim: true,
        },
        videoKey: {
            type: String,
            required: true,
            trim: true,
        },
    },
    { timestamps: true }
);

export default model("Comment", commentSchema);
