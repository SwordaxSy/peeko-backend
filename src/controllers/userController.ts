// imports
import express from "express";
import mongoose from "mongoose";
import requestIp from "request-ip";
import bcrypt from "bcrypt";
import cron from "node-cron";
import User from "../models/user";
import { UserObjectType, UserType, PeekoRequest } from "../types";
import { createToken, requireAuth } from "../middleware/authentication";
import { validateUser } from "../utils/validation";
import { generateActivationCode, formatTime } from "../utils/utils";
import sendEmail from "../utils/mailer";

// create router
const router = express.Router();

// variables
const tokenCookieOptions = (maxAge: number = 60 * 60 * 24 * 14) => {
    return {
        maxAge,
        httpOnly: true,
    };
};

/**
 * Schedule account delete operation on: {
 *      - unactivated accounts that lasted more than 10 minutes without getting activation code spam block
 *      - accounts that lasted more than 24 hours with activation code spam block
 * }
 */
const tenMinutes = 10 * 60 * 1000;
const oneDay = 24 * 60 * 60 * 1000;
cron.schedule("* * * * *", async () => {
    await User.deleteMany({
        $or: [
            {
                "activation.activated": false,
                "activation.blocked": false,
                createdAt: {
                    $lte: new Date(Date.now() - tenMinutes).toISOString(),
                },
            },
            {
                "activation.blocked": true,
                updatedAt: {
                    $lte: new Date(Date.now() - oneDay).toISOString(),
                },
            },
        ],
    });
});

/**
 * @post
 *      POST request to attempt registration
 */
router.post("/register", async (req, res) => {
    // destructure
    const { username, email, password, devActivation } = req.body;

    try {
        // get user ip address & attach it to deviceInfo object
        const ipAddress = requestIp.getClientIp(req) || undefined;
        const deviceInfo = req.body.deviceInfo || {};
        deviceInfo.ipAddress = ipAddress;

        // check devActivation
        const devActivated: boolean =
            !!devActivation && devActivation.password === process.env.DEV_CODE;

        // generate activation code
        const activationCode = generateActivationCode();

        // build user object structure
        const userObject: UserObjectType = {
            username,
            email,
            password,
            deviceInfo,
            activation: {
                activated: devActivated && devActivation.autoActivate,
                activationCode,
                attemptsLeft: 5,
                blocked: false,
            },
        };

        // validate user object
        const userObjectError = validateUser(userObject);
        if (userObjectError) {
            return res.status(400).json({
                success: false,
                error: userObjectError,
            });
        }

        // hash password
        const salt = await bcrypt.genSalt();
        const hashedPassword = await bcrypt.hash(password, salt);
        userObject.password = hashedPassword;

        // insert to db
        const userDocument: UserType = await User.create(userObject);
        userDocument.password = undefined;
        userDocument.deviceInfo = undefined;
        userDocument.activation!.activationCode = undefined;

        // send activation code on email
        if (!devActivated || !devActivation.autoActivate) {
            await sendEmail(email, username, activationCode);
        }

        // create & set token
        const token = await createToken(userDocument._id.toString());

        // return response
        res.status(200).json({
            success: true,
            userDocument,
            token: token,
            activationCode:
                devActivated && !devActivation.autoActivate
                    ? activationCode
                    : undefined,
        });
    } catch (err: any) {
        // if not mongoose validation error, log to server console
        if (
            err.code !== 11000 &&
            !(err instanceof mongoose.Error.ValidationError)
        ) {
            console.error(err);
        }

        // modify error message if duplicate username error
        if (err.code === 11000) {
            const objectKey = Object.keys(err.keyValue);

            if (objectKey.includes("username")) {
                err.message = `Username ${username} is already used. Try another username`;
            } else if (objectKey.includes("email")) {
                err.message = `An account with the email ${email} already exists`;
            } else {
                console.error(err);
            }
        }

        res.status(400).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * @post
 *      POST request to sign in
 */
router.post("/signIn", async (req, res) => {
    // destructure
    const { credential, password } = req.body;

    try {
        // try to find user
        const userDocument: UserType | null = await User.findOne({
            $or: [{ username: credential }, { email: credential }],
        });

        // if not found
        if (!userDocument) {
            return res.status(400).json({
                success: false,
                error: "Username or email is incorrect",
            });
        }

        // compare passwords
        const matching = await bcrypt.compare(password, userDocument.password!);
        if (!matching) {
            return res.status(400).json({
                success: false,
                error: "Password is incorrect",
            });
        }

        // remove unwanted properties
        userDocument.password = undefined;
        userDocument.deviceInfo = undefined;
        userDocument.activation!.activationCode = undefined;
        userDocument.viewed = undefined;

        // create & set token
        const token = await createToken(userDocument._id.toString());

        // return response
        res.status(200).json({
            success: true,
            userDocument,
            token: token,
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
 *      DELETE request to delete a user from the db
 */
router.delete("/deleteAccount", requireAuth, async (req: PeekoRequest, res) => {
    // destructure
    const userId = req.currentUser!._id;

    try {
        // delete user
        const deletedUserDocument: UserType | null =
            await User.findByIdAndDelete(userId);

        // if user not found
        if (!deletedUserDocument) {
            return res.status(400).json({
                success: false,
                error: "User not found",
            });
        }

        // remove unwanted properties
        deletedUserDocument.password = undefined;
        deletedUserDocument.deviceInfo = undefined;
        deletedUserDocument.activation!.activationCode = undefined;
        deletedUserDocument.viewed = undefined;

        // return response
        res.status(200).json({
            success: true,
            deletedUserDocument,
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
 * @put
 *      PUT request to activate unactivated account
 */
router.put("/activateAccount", async (req: PeekoRequest, res) => {
    // check user attached
    if (!req.currentUser) {
        return res.status(400).json({
            success: false,
            error: "Account not found",
        });
    }

    // if user blocked (for 24h)
    if (req.currentUser.activation!.blocked) {
        const msInDay = 24 * 60 * 60 * 1000;
        let unblockTime: number | Date | string =
            req.currentUser.updatedAt.getTime() + msInDay;
        unblockTime = formatTime(unblockTime);

        return res.status(400).json({
            success: false,
            attemptsLeft: 0,
            error: `Email and username blocked from registration until ${unblockTime}`,
        });
    }

    // if user already activated
    if (req.currentUser.activation!.activated) {
        return res.status(400).json({
            success: false,
            error: "Invalid request. Account already activated",
        });
    }

    // destructure
    const userId = req.currentUser._id;
    const activationCode = req.currentUser.activation!.activationCode;
    const givenCode = req.body.activationCode;

    try {
        let errorMessage: string = "";
        const activationSuccess = activationCode === givenCode;

        const result = (await User.findByIdAndUpdate(
            userId,
            {
                $set: {
                    "activation.activated": activationSuccess,
                },
                $inc: {
                    "activation.attemptsLeft": -1,
                },
            },
            { new: true }
        )) as UserType;

        // if no mroe attempts left and activation failed for the last attempt
        if (result.activation!.attemptsLeft === 0 && !activationSuccess) {
            await User.findByIdAndUpdate(userId, {
                "activation.blocked": true,
            });

            errorMessage =
                "You used all your activation attempts, email and username will be blocked from registration for 24 hours";
        }

        // if activation success, else
        if (activationSuccess) {
            res.status(200).json({
                success: true,
            });
        } else {
            errorMessage = errorMessage || "Incorrect activation code";

            res.status(400).json({
                success: false,
                error: errorMessage,
                attemptsLeft: result.activation!.attemptsLeft,
            });
        }
    } catch (err: any) {
        console.error(err);
        res.status(400).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * @put
 *      PUT request to update the recorded IP address of the user
 */
router.put("/updateIpAddress", requireAuth, async (req: PeekoRequest, res) => {
    // destructure ip address
    const userId = req.currentUser!._id;

    try {
        // get ipAddress
        const ipAddress = requestIp.getClientIp(req);

        const result = await User.findByIdAndUpdate(userId, {
            "deviceInfo.ipAddress": ipAddress,
        });

        if (!result) {
            return res.status(400).json({
                success: false,
                error: "User not found",
            });
        }

        res.status(200).json({
            success: true,
            ipAddress,
        });
    } catch (err: any) {
        console.error(err);
        res.status(400).json({
            success: false,
            error: err.message,
        });
    }
});

// export router
export default router;
