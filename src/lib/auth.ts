import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);

import { prisma } from "./db";
import EmailVerfication from "@/components/EmailVerfication";
export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  plugins: [nextCookies()],
  //   aditional fields
  user: {
    additionalFields: {
      role: {
        type: "string",
        default: "SELLER",
        // Never settable through sign-up or update-user. Without this, anyone
        // could send role: "ADMIN" and promote themselves.
        input: false,
      },
      number: {
        type: "string",
        default: "",
      },
      image: {
        type: "string",
        default: "",
      },
      image_id: {
        type: "string",
        default: "",
      },
    },
  },
  hooks: {
    // Staff accounts are created by an admin (settings) or the local setup
    // route, both of which call auth.api directly. Requests that arrive over
    // HTTP carry ctx.request, so this closes the public sign-up endpoint
    // without breaking those server-side calls.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email" && ctx.request) {
        throw new APIError("FORBIDDEN", {
          message: "Sign-up is disabled. Ask an admin to create your account.",
        });
      }
    }),
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      const typedUser = user as (typeof auth.$Infer.Session)["user"];
      const { error } = await resend.emails.send({
        from: "onboarding@resend.dev",
        to: user.email,
        subject: "Verify your email address",
        text: `Click the link to verify your email: ${url}`,
        react: EmailVerfication({
          userName: user.name,
          role: typedUser.role,
          verificationUrl: url,
          storeName: "Dawaare",
        }),
      });
      
      if (error) {
        console.error("Resend API Error:", error);
      }
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },
});

export type User = (typeof auth.$Infer.Session)["user"];
