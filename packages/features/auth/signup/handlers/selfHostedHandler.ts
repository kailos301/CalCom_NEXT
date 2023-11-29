import type { NextApiRequest, NextApiResponse } from "next";

import { checkPremiumUsername } from "@calcom/ee/common/lib/checkPremiumUsername";
import { hashPassword } from "@calcom/features/auth/lib/hashPassword";
import { sendEmailVerification } from "@calcom/features/auth/lib/verifyEmail";
import { IS_PREMIUM_USERNAME_ENABLED } from "@calcom/lib/constants";
import slugify from "@calcom/lib/slugify";
import { closeComUpsertTeamUser } from "@calcom/lib/sync/SyncServiceManager";
import { validateUsername } from "@calcom/lib/validateUsername";
import prisma from "@calcom/prisma";
import { IdentityProvider, MembershipRole } from "@calcom/prisma/enums";
import { signupSchema } from "@calcom/prisma/zod-utils";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

import { joinAnyChildTeamOnOrgInvite } from "../utils/organization";
import { findTokenByToken, throwIfTokenExpired, validateUsernameForTeam } from "../utils/token";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const data = req.body;
  const { email, password, language, token } = signupSchema.parse(data);

  const username = slugify(data.username);
  const userEmail = email.toLowerCase();

  if (!username) {
    res.status(422).json({ message: "Invalid username" });
    return;
  }

  let foundToken: { id: number; teamId: number | null; expires: Date } | null = null;
  if (token) {
    foundToken = await findTokenByToken({ token });
    throwIfTokenExpired(foundToken?.expires);
    await validateUsernameForTeam({ username, email: userEmail, teamId: foundToken?.teamId });
  } else {
    const userValidation = await validateUsername(username, userEmail);
    if (!userValidation.isValid) {
      return res.status(409).json({ message: "Username or email is already taken" });
    }
  }

  const hashedPassword = await hashPassword(password);

  if (foundToken && foundToken?.teamId) {
    const team = await prisma.team.findUnique({
      where: {
        id: foundToken.teamId,
      },
    });
    if (team) {
      const teamMetadata = teamMetadataSchema.parse(team?.metadata);

      const user = await prisma.user.upsert({
        where: { email: userEmail },
        update: {
          username,
          password: hashedPassword,
          emailVerified: new Date(Date.now()),
          identityProvider: IdentityProvider.CAL,
        },
        create: {
          username,
          email: userEmail,
          password: hashedPassword,
          identityProvider: IdentityProvider.CAL,
        },
      });

      const membership = await prisma.$transaction(async (tx) => {
        if (teamMetadata?.isOrganization) {
          await tx.user.update({
            where: {
              id: user.id,
            },
            data: {
              organizationId: team.id,
            },
          });
        }
        const membership = await tx.membership.upsert({
          where: {
            userId_teamId: { userId: user.id, teamId: team.id },
          },
          update: {
            accepted: true,
          },
          create: {
            userId: user.id,
            teamId: team.id,
            role: MembershipRole.MEMBER,
            accepted: true,
          },
        });
        return membership;
      });

      closeComUpsertTeamUser(team, user, membership.role);

      // Accept any child team invites for orgs.
      if (team.parentId) {
        await joinAnyChildTeamOnOrgInvite({
          userId: user.id,
          orgId: team.parentId,
        });
      }
    }

    // Cleanup token after use
    await prisma.verificationToken.delete({
      where: {
        id: foundToken.id,
      },
    });
  } else {
    if (IS_PREMIUM_USERNAME_ENABLED) {
      const checkUsername = await checkPremiumUsername(username);
      if (checkUsername.premium) {
        res.status(422).json({
          message: "Sign up from https://cal.com/signup to claim your premium username",
        });
        return;
      }
    }
    await prisma.user.upsert({
      where: { email: userEmail },
      update: {
        username,
        password: hashedPassword,
        emailVerified: new Date(Date.now()),
        identityProvider: IdentityProvider.CAL,
      },
      create: {
        username,
        email: userEmail,
        password: hashedPassword,
        identityProvider: IdentityProvider.CAL,
      },
    });
    await sendEmailVerification({
      email: userEmail,
      username,
      language,
    });
  }

  res.status(201).json({ message: "Created user" });
}
