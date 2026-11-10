// The PAC runtime is isolated from the extension bundle, so it embeds the same tldts build the engine imports.
// tldts-icann holds only the ICANN suffixes, the ones a default tldts lookup reads, in two thirds of the size.

import source from "tldts-icann/dist/index.umd.min.js" with { type: "text" };
import license from "./tldts.LICENSE" with { type: "text" };

export const publicSuffixSource = `/*! tldts\n${license}*/\n${source}`;
