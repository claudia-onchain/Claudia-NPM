import { byteplus } from "./byteplus.js";
import { elevenlabs } from "./elevenlabs.js";
import { fal } from "./fal.js";
import { google } from "./google.js";
import { heygen } from "./heygen.js";
import { openai } from "./openai.js";
import { runway } from "./runway.js";
import type { Connector } from "./base.js";
import type { ProviderId } from "../types.js";

/** Provider connectors, in the order they are listed to users. */
export const CONNECTORS: Record<ProviderId, Connector> = { google, openai, fal, elevenlabs, heygen, runway, byteplus };
