// The PAC runtime is isolated from the extension bundle, so it embeds the same tldts build the engine imports.

import source from "tldts/dist/index.umd.min.js" with { type: "text" };
import license from "./tldts.LICENSE" with { type: "text" };

export const publicSuffixSource = `/*! tldts\n${license}*/\n${source}`;
