const {
  LINK_MODERATION_TIMEOUT_MS,
  NEW_ACCOUNT_LINK_SCRUTINY_MS,
  NEW_MEMBER_LINK_SCRUTINY_MS,
  RAID_WINDOW_MS,
  RAID_MIN_DISTINCT_USERS,
  RAID_ALERT_COOLDOWN_MS,
  SUSPICIOUS_ALERT_WINDOW_MS,
  SUSPICIOUS_WARNING_THRESHOLD,
  SUSPICIOUS_TIMEOUT_THRESHOLD,
  SUSPICIOUS_TIMEOUT_MS,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS,
  SELLING_CONFIDENCE_TIMEOUT_THRESHOLD,
  SELLING_CONFIDENCE_TIMEOUT_TIERS,
  SELLING_LOW_CONFIDENCE_THRESHOLD,
  SELLING_REPEAT_WINDOW_MS,
  SELLING_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_TIMEOUT_MS,
  BRAND
} = require("../config");
const {
  MODLOG_REVERT_PREFIX,
  MODLOG_VIEW_PREFIX,
  buildModerationLogButtonRows,
  buildScamReviewButtonRows
} = require("../components");
const { buildNormalizedTextForms } = require("../text");
const { formatDuration } = require("../duration");
const {
  buildPanel,
  DANGER,
  INFO,
  SUCCESS,
  TEAL,
  WARN,
  resolveAvatarURL,
  brandAuthor,
  ansi,
  terminalBlock,
  kpi,
  kpiTone
} = require("../embed");
const viz = require("../embed-viz");
const ui = require("../ui");
const { fetchKb } = require("../kb");
const { detectBlockedLinkSignal, detectBlockedLinkSignalAsync, extractUrlsFromText } = require("../link-policy");
const { sendIgnoreLogPanel, sendLogPanel } = require("../log-channel");
const { canUseEmojiCommands, hasModerationBypassMessage } = require("../permissions");
const { detectProhibitedCommerce, similarity } = require("../prohibited-commerce");
const {
  cleanupExpiredModerationActions,
  deleteModerationAction,
  getModerationAction,
  isModerationWhitelistedUser,
  listTrustedLinks,
  recordDailyModerationEvent,
  recordModerationAction,
  recordScamDecisionAudit
} = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");
const { getRuntimeStatus } = require("../runtime-status");
const { classifyScamContextWithGemini } = require("../scam-ai");
const { classify: classifyScamDecomposed } = require("../scam-decompose");
const {
  classifyScamContextLocally,
  classifyScamContextLocallyAsync,
  isExplanationResponseIntent,
  isKiciaLegitPurchaseIntent,
  isSafePurchaseMethodQuestion
} = require("../scam-local-classifier");
const { cleanText, foldConfusableText, normalizeText } = require("../text");
const { maybeClassifyToxicityShadow } = require("../toxicity-shadow");
const { safeReply, safeSend } = require("../utils/respond");

const raidBuckets = new Map();
const lastRaidAlertAt = new Map();
const recentUserMessages = new Map();
const suspiciousUserBuckets = new Map();
const sellingUserBuckets = new Map();

const SELL_ITEM_RE = /\b(?:acc|account|accounts|akkount|akkounts|ackount|ackounts|lvl|level|configuration|config|configs|confg|confgs|conf|confs|cfg|cfgs|cfk|executor|executors|script|scripts|hvh|kicia|kiciahook|kcia|kicka|premium|prem|prm|license|licenses|key|keys|cheat|cheats|exploit|exploits|robux|nitro|enhancement|enhancements)\b/;
const SELL_SHORT_CONTEXT_ITEM_RE = /\b(?:ue)\b/;
const SELL_MARKET_RE = /\b(?:price|prices|usd|paypal|cashapp|crypto|cheap|paid|money|shop|store|offer|offers|buy|buyer|buying|bucks?|dollars?|robux|rbx|trade|trades|trading|swap|swapping|exchange|middleman|mm)\b/;
const KICIA_VALUE_EXCHANGE_RE = /\b(?:kicia|kiciahook|kcia|kicka|premium|prem|prm|license|licenses|key|keys|ue)\b.{0,45}\bfor\b.{0,45}\b(?:volt|robux|rbx|account|accounts|acc|alts?|config|configs|cfg|cfgs|money|usd|dollars?|bucks?|paypal|cashapp|crypto|nitro|script|scripts|executor|executors)\b|\b(?:volt|robux|rbx|account|accounts|acc|alts?|config|configs|cfg|cfgs|money|usd|dollars?|bucks?|paypal|cashapp|crypto|nitro|script|scripts|executor|executors|ue)\b.{0,45}\bfor\b.{0,45}\b(?:kicia|kiciahook|kcia|kicka|premium|prem|prm|license|licenses|key|keys)\b/;
const SELL_PRICE_RE = /(?:^|\s)(?:[$\u20ac\u00a3]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:bucks?|dollars?|usd|eur|gbp|robux|rbx)|for\s+\d+(?:\.\d+)?)(?:\s|$)/;
const SELL_MONEY_EMOJI_RE = /[\u{1F4B0}\u{1F4B5}-\u{1F4B8}\u{1F911}]/u;
const SELL_CONTEXT_WINDOW_MS = 2 * 60 * 1000;
const SELL_CONTEXT_MAX_MESSAGES = 5;
const SELL_OFFER_PATTERNS = [
  /\b(?:i am|im|i m)\s+selling\b/,
  /\b(?:i am|im|i m)\s+trading\b/,
  /\b(?:i am|im|i m)\s+buying\b/,
  /\b(?:i am|im|i m)\s+giving\b/,
  /\bfor sale\b/,
  /\bdm (?:me )?(?:to buy|for prices?|for price|if you want to buy)\b/,
  /\b(?:do|would)\s+(?:you|u)\s+(?:want|wanna|wana)\s+(?:to\s+)?(?:buy|trade|swap)\s+(?:my|this|these|the)\b/,
  /\b(?:you|u)\s+(?:want|wanna|wana)\s+(?:to\s+)?(?:buy|trade|swap)\s+(?:my|this|these|the)\b/,
  /\bbuy (?:my|from me)\b/,
  /\bgiving (?:out )?(?:my )?(?:accounts?|configs?|cfgs?|scripts?|keys?|premium|robux)\b/,
  /\boffering (?:my )?(?:accounts?|configs?|cfgs?|scripts?|keys?|premium|robux)\b/,
  /\btaking offers\b/,
  /\bwts\b/,
  /\bwtb\b/
];
const SELL_ANTI_PATTERNS = [
  /\b(?:stop|dont|don't|do not|no)\s+selling\b/,
  /\b(?:stop|dont|don't|do not|no)\s+sell\b/,
  /\bselling\s+is\s+against\s+rules?\b/,
  /\bsell(?:ing)?\s+is\s+not\s+allowed\b/,
  /\b(?:cant|can't|cannot)\s+sell\b/,
  /\bnot\s+allowed\s+to\s+sell\b/,
  /\b(?:not|never)\b.{0,40}\b(?:selling|trading|buying)\b/,
  /\b(?:how\s+to\s+)?(?:block|report|remove|ban|catch|detect|filter)\b.{0,80}\b(?:acc(?:ount)?s?|selling|trading|paid|cfgs?|configs?|scripts?|free\s+robux|robux\s+scams?)\b/,
  /\b(?:selling|trading|sold|paid|premium|prem|configs?|cfgs?|accounts?|scripts?|free\s+robux|robux)\b.{0,80}\b(?:violates?|against|not\s+allowed|rules?|should\s+never|never\s+be|blocked?|reported?|scams?|fake)\b/,
  /\b(?:do\s+not|don't|dont|never|avoid|stop)\b.{0,80}\b(?:dm|dms|message|msg|buy|sell|selling|trade|trading|free\s+robux|robux\s+scams?|scams?)\b/,
  /\b(?:saw|seen|reported?|warn(?:ed)?|say|said|says|asking|asked|mentions?|mentioned)\b.{0,80}\b(?:free\s+robux|selling|trading|paid\s+cfg|configs?|accounts?|scripts?|scams?)\b/,
  /\b(?:parental\s+controls?|controls?)\b.{0,60}\b(?:work|working|help|support)\b.{0,40}\brobux\b/,
  /\b(?:is\s+this|is\s+that|are\s+these)\s+allowed\b/,
  /\b(?:someone|somebody|user|person|people|they|he|she)\b.{0,60}\b(?:said|says|asked|told|selling|trading|scamming)\b.{0,60}\b(?:allowed|rules?|report)\b/,
  /\b(?:how|where|can|could|do|does|what)\b.{0,70}\b(?:buy|purchase|get|pay|price|cost)\b.{0,50}\b(?:premium|prem|prm|license|key|early access|kicia|kiciahook|kh)\b/,
  /\bhow\s+much\s+for\s+(?:premium|prem|prm|license|key|kicia|kiciahook|kh)\b/,
  /\b(?:i|im|i m)\s+(?:need|want|wanna|wana|just\s+want|jst\s+wana)\b.{0,50}\b(?:buy|get|purchase)\b.{0,50}\b(?:premium|prem|prm|pre|early access|ealy acces|kh|kicia)\b/,
  /\b(?:buy|purchase|get)\s+it\s+from\s+the\s+(?:person|one|owner|dev|developer|maker)\b/,
  /\b(?:reseller|resellers|reselling|reslling)\b.{0,90}\b(?:work|works|need|needs|buy|stock|codes?|price|official|person|maker)\b/,
  /\b(?:reselling|reslling|resell(?:er|ers)?)\b.{0,60}\bvirtual\s+client\b/,
  /\b(?:make|get|got)\s+a\s+new\s+acc\b/,
  /\b(?:best|working)\s+(?:config|configs|cfg|cfgs|confg|confgs)\b/,
  /\b(?:config|configs|cfg|cfgs|confg|confgs)\s+for\s+(?:it|kicia|kiciahook|ue)\b/,
  /\b(?:v3|kicia|kiciahook|premium|prem|prm)\b.{0,35}\b(?:released|dropped|users?|ragebot|comes|coming)\b/,
  /\b(?:premium|prem|prm)\b.{0,35}\b(?:back|ver|version|do|does|possible)\b/,
  /\b(?:ty|thanks|thank you)\b.{0,35}\b(?:untimeout|untimouting|untime?out|unmuting|unmute)\b/,
  /\bdm me\b.{0,50}\b(?:friend|freind)\s+req\b/,
  /\b(?:give|send|drop)\s+(?:me\s+)?(?:free\s+)?(?:executor|exec|config|cfg|confg|configuration)\b/,
  /\b(?:send|give|drop)\s+(?:me\s+)?(?:the\s+)?(?:link|invite)\b.{0,70}\b(?:server|executor|exec|exe)\b.{0,30}\bdms?\b/,
  /\bwhich\s+(?:exec|execs|executor|executors)\s+work\s+for\s+kicia\b/,
  /\bi\s+use\s+it\s+for\s+crypto\s+business\b/
];
const SELL_POLICY_NEGATIVE_CONDENSED_PATTERNS = [
  /(?:not|never).{0,40}(?:seling|selling|trading|buying)/,
  /(?:block|report|remove|ban|catch|detect|filter).{0,80}(?:account|accounts|acc|selling|trading|paid|cfg|config|configs|script|scripts|freerobux|robuxscams)/,
  /(?:selling|trading|sold|paid|premium|prem|config|configs|cfg|account|accounts|script|scripts|freerobux|robux).{0,80}(?:violates|against|notallowed|rules|shouldnever|neverbe|blocked|reported|scams|fake)/,
  /(?:donot|dont|never|avoid|stop).{0,80}(?:dm|dms|message|msg|buy|sell|selling|trade|trading|freerobux|robuxscams|scams)/,
  /(?:saw|seen|reported|warned|say|said|says|asking|asked|mention|mentioned).{0,80}(?:freerobux|selling|trading|paidcfg|config|configs|account|accounts|script|scripts|scams)/,
  /parentalcontrols?.{0,80}(?:work|working|help|support).{0,40}robux/
];
const SELL_NEUTRAL_WORD_RE = /\bresellers?\b/g;
const SELL_BROAD_INTENT_RE = /\b(?:sell|selling|seller|sold|buy|buying|buyer|trade|trading|trader|swap|swapping|exchange|give|giving|offer|offering|scam|scamming)\b/;
const SELL_FUZZY_INTENT_TERMS = ["sell", "selling", "buy", "buying", "trade", "trading", "swap", "exchange", "giving", "offering"];
const SELL_FUZZY_ITEM_TERMS = [
  "key",
  "keys",
  "license",
  "licenses",
  "account",
  "accounts",
  "config",
  "configs",
  "conf",
  "confs",
  "cfg",
  "cfgs",
  "cfk",
  "executor",
  "script",
  "premium",
  "prem",
  "prm",
  "kicia",
  "kiciahook",
  "robux"
];
const SELL_CONFIG_ALIAS_RE = /\b(?:cfgs?|cfigs?|configs?|confgs?|confs?|cfk)\b/;
const SELL_OBFUSCATED_CONFIG_ALIAS_RE = /\b(?:figs?)\b/;
const SELL_CONDENSED_INTENT_RE = /(?:s+e+l+l+(?:i+n+g+|n+g+|i+n+|e+r+)?)|(?:s+e+i+n+g+)|(?:s+o+l+d+)|(?:b+u+y+(?:i+n+g+)?)|(?:t+r+a?d+(?:i+n+g+|i+n+k+|n+g+|e+r+)?)|(?:s+w+a+p+)|(?:w+t+s+)|(?:w+t+b+)|(?:g+i+v+(?:i+n+g+|e+)?)|(?:o+f+f+e+r+(?:i+n+g+)?)|(?:f+o+r+s+a+l+e+)/;
const SELL_CONDENSED_ITEM_RE = /(?:a+c+c+(?:o+u+n+t+)?)|(?:a+k+k+o+u+n+t+)|(?:a+c+k+o+u+n+t+)|(?:l+v+l+|l+e+v+e+l+)|(?:c+f+g+|c+f+k+|c+o+n+f+i*g+|c+o+n+f+g+)|(?:e+x+e+c+u+t+o+r+)|(?:s+c+r+i+p+t+)|(?:p+r+e+m+(?:i+u+m+)?|p+r+m+)|(?:l+i+c+e+n+s+e+)|(?:k+e+y+)|(?:k+i+c+i+a+|k+c+i+a+|k+i+c+k+a+)|(?:k+i+c+i+a+h+o+o+k+)|(?:r+o+b+u+x+)|(?:h+v+h+)/;
const SELL_STRONG_INTENT_RE = /^(?:(?:i am|im|i m)\s+)?(?:selling|trading|buying)\b|^(?:sell|trade|buy)\b|^(?:wts|wtb)\b|^for sale\b/;
const SELL_CONTEXT_NEGATIVE_RE = /\b(?:against rules?|not allowed|selling is|trading is|buying is|rules say|rule says|scammer|scamming is|report scam|avoid scam)\b/;
const PRIVATE_HANDOFF_RE = /\b(?:dm|dms|pm|pms|private|privately|message me|msg me|inbox|add me|bio|profile)\b/;
const MARKET_QUESTION_RE = /^(?:anyone|who|where|can i|am i allowed|is it allowed|do you|does anyone|does someone|does somebody|do any1|do someone|do somebody)\b/;
const WANT_OFFER_RE = /\b(?:who|anyone|somebody|someone|any1|some1)\s+(?:wants?|wanna|wana|want|need)\b|\b(?:wanna|wana)\s+(?:buy|trade|swap)\b|\b(?:do|would)\s+(?:you|u)\s+(?:want|wanna|wana)\s+(?:to\s+)?(?:buy|trade|swap)\b|\b(?:you|u)\s+(?:want|wanna|wana)\s+(?:to\s+)?(?:buy|trade|swap)\b/;
const RESOURCE_AVAILABILITY_QUESTION_RE = /^(?:hey\s+)?(?:does|do)\s+(?:someone|somebody|anyone|anybody|some1|any1)\s+(?:have|has|got)\b|^(?:hey\s+)?(?:who|anyone|anybody|someone|somebody|some1|any1)\s+(?:has|have|got)\b/;
const SAFE_SUPPORT_CONTEXT_RE = /\b(?:help|support|supports?|supported|ticket|docs?|documented|issue|problem|bug|fix|freez(?:e|ing)|crash(?:ing|ed|es)?|load(?:ing|s)?|detected|detect|ban(?:ned)?|not\s+working|working|works|work|compatible|compat|usable|login|locked|settings?|renew|using|use|uses|run|runs|running|inject|injects|injecting|injection|undetected|undetect|rootkit|spyware|trojan|virus|malware|sus|sketchy|legit|free|free\s+on|free\s+for|downgrade|version|build|installer|setup|update|outdated|reinstall|reset)\b/;
const SAFE_GAMEPLAY_CONTEXT_RE = /\b(?:rivals|ffa|match(?:es)?|levels?|lvl|ping|bars?|beat|playing|play|glazer|chat|goofy|loadout|ragebot|lua|slots?|staff|answer|friend\s+req|freind\s+req|muted|untimeout|released|dropped|early\s+access|ealy\s+acces|hvh\s+(?:partner|match|session|player|players|wanna|anyone)|wanna\s+hvh|who\s+wanna\s+hvh|valorant|fortnite|minecraft|cs|csgo|cs2|apex|warzone|aimbot|aim|skin\s+changer|colorbot)\b/;
const ACTIONABLE_DEAL_LANGUAGE_RE = /\b(?:sell|selling|seller|sold|buy\s+(?:my|from\s+me)|from\s+me|trade|trading|swap|exchange|wts|wtb|for\s+sale|taking\s+offers|cheap|paid|money|paypal|cashapp|crypto|shop|store|middleman|mm)\b/;
const MODERATION_ACTION_REVIEW_MAX_MS = 12 * 60 * 60 * 1000;
const MODERATION_CONTEXT_VIEW_LIMIT = 8;
const MODERATION_DELETE_CONTEXT_LIMIT = 3;

const SUSPICIOUS_PATTERNS = [
  {
    label: "credential-request",
    pattern: /\b(?:send|give|share|paste)\s+(?:me\s+)?(?:your\s+)?(?:password|token|cookie|cookies|login|2fa|mfa|otp|code)\b/,
    reason: "asking for private account credentials",
    confidence: 98
  },
  {
    label: "private-more-info",
    pattern: /\b(?:more|extra|other)\s+(?:stuff|info|details|links?|files?)\b.*\b(?:dm|pm|message|msg)\s+me\b/,
    reason: "moving extra details into private messages",
    confidence: 86
  },
  {
    label: "dm-link-offer",
    pattern: /\b(?:dm|pm|message|msg)\s+me\s+for\s+(?:the\s+|a\s+)?(?:link|download|invite|crack|leak|file|script|executor|key|account|config)\b/,
    reason: "offering links privately",
    confidence: 93
  },
  {
    label: "cracked-or-leaked",
    pattern: /\b(?:cracked|leaked)\s+(?:kicia|kiciahook|premium)\b/,
    reason: "mentioning cracked or leaked product access",
    confidence: 96
  },
  {
    label: "paste-this",
    pattern: /\b(?:paste|run|download)\s+this\b/,
    reason: "asking users to run, download, or paste unknown content",
    confidence: 92
  },
  {
    label: "free-premium",
    pattern: /\bfree premium\b/,
    reason: "claiming free premium access",
    confidence: 91
  },
  {
    label: "free-robux-bio",
    pattern: /\bfree\s+robux\b.{0,40}\b(?:bio|profile|dm|dms|link|click|claim)\b|\b(?:bio|profile)\b.{0,40}\bfree\s+robux\b/,
    reason: "claiming free robux through a profile, DM, claim, or link path",
    confidence: 94
  },
  {
    label: "account-report-scam",
    pattern: /\b(?:accidentally|mistakenly)\s+reported\s+(?:you|your\s+account|ur\s+account)\b/,
    reason: "using the accidental-report account scam wording",
    confidence: 94
  },
  {
    label: "account-urgency",
    pattern: /\b(?:your\s+)?(?:account|profile)\s+(?:will\s+be\s+)?(?:deleted|disabled|suspended|terminated|locked)\b.*\b(?:verify|appeal|contact|dm|message|link)\b/,
    reason: "pressuring a user to verify or appeal an account issue",
    confidence: 90
  },
  {
    label: "qr-or-oauth-steering",
    pattern: /\b(?:scan\s+(?:this\s+)?qr|oauth|authorize\s+(?:this\s+)?(?:bot|app|application))\b/,
    reason: "steering users into QR or OAuth authorization flow",
    confidence: 88
  }
];
const SUSPICIOUS_ANTI_PATTERNS = [
  /\b(?:don t|dont|do not|stop)\s+(?:dm|pm|message|msg)\s+me\b/,
  /\b(?:don t|dont|do not|never)\s+(?:paste|run|download|click|open)\s+this\b/,
  /\b(?:watch|avoid|report)\s+(?:the\s+)?(?:accidental|account)\s+report\s+scam\b/,
  /\b(?:do not|dont|don t|never|avoid|stop)\b.{0,60}\bfree\s+robux\b.{0,40}\bscams?\b/,
  /\b(?:saw|seen|say|said|says|reported|warned)\b.{0,80}\bfree\s+robux\b.{0,80}\b(?:reported|scams?|fake|warning)\b/,
  /\b(?:never|do not|dont|don t)\s+(?:scan|use)\s+(?:a\s+)?qr\b/,
  /\b(?:never|do not|dont|don t)\s+(?:authorize|oauth)\b/
];
const SUSPICIOUS_PUBLIC_REPLIES_BY_HIT = [
  [
    "the wording is wording",
    "buddy what was that",
    "ts ain't it",
    "yeah no that sentence had legs",
    "say less. like genuinely",
    "the 'free' arc has begun",
    "ngl the way you typed that is loud",
    "lil bro really thought we wouldn't read it",
    "phrasing chose violence",
    "casual sentence carrying a weapon",
    "first card on the table and it's already a joker",
    "soft red flag, audible breeze",
    "ok. noted",
    "the dm-me vibes are immediate",
    "bro typed that with intent",
    "one (1) eyebrow raised",
    "sentence had subtitles",
    "icl that came outta nowhere",
    "buddy you alright?",
    "the wording is sus and you know it",
    "ts smells like a setup ngl",
    "first warning shot, do better"
  ],
  [
    "alright that's two, on purpose now huh",
    "okay this is a pattern, lil bro",
    "second message same exact energy, suspicious",
    "you typing or auditioning",
    "the script is starting to show",
    "buddy you might wanna stop while you're behind",
    "ngl this is starting to look planned",
    "ts is a setup and i can read all of it",
    "second offense, mods waking up",
    "imagine running it back",
    "two strikes and you're still committed, respectfully",
    "bro is rehearsing in real time",
    "the consistency is the part that's getting you",
    "ok now i'm watching you type",
    "second time saying weird things, weird",
    "this ain't a freestyle anymore, it's a draft",
    "bro really doubled down on the bit",
    "the eyebrow is permanently raised at this point",
    "ts is giving 'i have a plan'",
    "twice in one breath is wild work"
  ],
  [
    "alright that's three, mute incoming",
    "ok lil bro the timeout is loading",
    "third strike, bro genuinely committed to losing this account",
    "you ran the same bit three times in chat. buddy",
    "imagine getting muted for this exact set of words",
    "trifecta achieved, claim your prize at the door",
    "bro is speedrunning a temp ban any% no glitches",
    "third one confirmed, mods are stretching",
    "and that's the hat trick, well done",
    "bro hit final boss form and lost",
    "icl this is impressive in the worst way",
    "you really really meant it. respect, kinda",
    "ts is autopilot scammer mode and it's not even good",
    "third message same energy, mute booked",
    "lil bro typed three felonies in a row"
  ]
];
const SELLING_PUBLIC_REPLIES = [
  "no trades in here lil bro this ain't ebay",
  "bro it's free. like literally free. F R E E",
  "selling kicia is wild when kicia is free",
  "buddy ts is a roblox server not a stock exchange",
  "trade offer received: nothing | trade offer rejected",
  "bro typed 'trust me' and i felt my insurance lapse",
  "lil bro got the entrepreneur dlc and lost the receipt",
  "imagine pricing something that costs zero",
  "you tried to sell a free thing, brave choice",
  "bro is reselling oxygen at a markup",
  "the only thing for sale here is your dignity apparently",
  "12 word pitch, 11 of them red flags",
  "bro flexed a venmo in a discord server, brave",
  "selling that here is like selling ice in antarctica",
  "ts giving 'i lost my job and chose violence'",
  "bro tried to dm-handoff and got moderated mid-keystroke",
  "shop closed before it opened, classic",
  "lil bro ran a yard sale in a public chat",
  "the pitch was fully sentence-shaped and still got rejected",
  "my guy nobody asked. said no one to your offer",
  "the sale: -1 stars",
  "you really tried to monetize. in here. of all places",
  "bro took 'side hustle' way too literally",
  "imagine going broke selling free things",
  "lil bro pulled out a payment method like it was a gun",
  "the trade ended before it started",
  "bro thought general was a marketplace, mistake",
  "ngl the audacity is the only thing free here",
  "you priced air and we all said no",
  "selling ts is a personality flaw",
  "bro typed a price tag in a server with one (1) admin online",
  "the storefront was a discord message and that's already too much",
  "lil bro you have no inventory, what are you selling",
  "icl that pitch had the budget of a piece of paper",
  "bro's business plan was 'and then i make money somehow'",
  "the listing went up and the down vote was instant"
];
const PROHIBITED_SALE_PUBLIC_REPLIES = [
  "bro listed contraband in general chat with full confidence 💀",
  "selling that here? mods just unlocked an achievement",
  "lil bro speedran the tos in record time",
  "imagine going to jail for a roblox account",
  "bro tried to flip an account like a house",
  "selling accounts is a whole hosting issue, buddy",
  "bro is one keystroke from a permanent vacation",
  "lil bro tried to run an illegal market in front of staff, brave",
  "the catalog itself was a violation",
  "bro listed forbidden dlc and got patched mid-sentence",
  "tos took one look and said no",
  "the offer was illegal before the price was even shown",
  "bro is collecting felonies like trading cards",
  "imagine a permaban for a free game's account",
  "ngl that listing was a self report",
  "the marketplace said absolutely not and locked the door",
  "bro was three letters away from a roblox investigation",
  "ts equals welcome to the mute pit",
  "you really thought 'illegal' was a flavor",
  "lil bro the only thing you're selling is your future on this server",
  "bro listed something so banned the message itself flinched",
  "selling that = me hitting the red button",
  "ts giving 'first time on the internet' energy",
  "imagine getting banned for selling someone else's roblox account",
  "lil bro that's not a sale that's evidence"
];
const ROASTING_PATTERNS = [
  /\b(?:bro|blud|vro|lil bro)\s+(?:got\s+)?(?:cooked|roasted|fried|smoked|destroyed|packed)\b/,
  /\b(?:someone|somebody|some1|bro|blud|vro|lil bro)\s+(?:is\s+)?(?:getting\s+)?(?:cooked|roasted|fried|smoked|destroyed|packed)\b/,
  /\b(?:get|got|getting|is|are|was|were)\s+(?:absolutely\s+)?(?:cooked|roasted|fried|smoked|destroyed|packed)\b/,
  /\b(?:cook|cooked|cooking|roast|roasted|roasting)\s+(?:him|her|them|that|this|bro|blud|vro|lil bro)\b/,
  /\b(?:skill issue|ratio|you fell off|washed|pack watch|hold this l)\b/,
  /\b(?:clown|bozo)\s+(?:moment|behavior|energy|activity)\b/,
  /\b(?:you|u|he|she|they|bro|blud|vro|lil bro)\s+(?:are|re|is|a|an)?\s*(?:npc|bot|bots?)\s+(?:anyways?|fr|ngl|lol|lmao)?\b/,
  /\b(?:npc|bot)\s+(?:behavior|activity|energy|moment)\b/,
  /\bhopping\s+from\s+one\s+to\s+another\b/,
  /\balways\s+the\s+same\s+(?:sht|shit|thing|bs)\b/,
  /\bsame\s+(?:sht|shit|bs)\b/
];
const ROASTING_IGNORE_PATTERNS = [
  /\b(?:cook|cooked|cooking)\s+(?:food|meal|dinner|lunch|breakfast|rice|chicken|pizza|recipe)\b/,
  /\broast(?:ed|ing)?\s+(?:coffee|beans|chicken|beef|pork|potatoes)\b/
];
const ROASTING_PUBLIC_REPLIES = [
  "ts heating up in here 🔥",
  "the kitchen is officially open",
  "icl that one had teeth",
  "bro got cooked while loading his comeback",
  "small flame detected, growing fast",
  "the cookout has begun, grab a plate",
  "someone is on the menu and they don't know yet",
  "ngl chat is throwing hands",
  "ts giving thanksgiving energy",
  "lil oven moment in here",
  "the smoke detector just blinked",
  "bro caught a verbal kicia ban",
  "lil bro getting roasted while typing his reply",
  "chat brought ingredients today",
  "the seasoning is being applied generously",
  "this is becoming a barbecue and i'm here for it",
  "the temperature gained two levels",
  "bro caught hands and not the response",
  "ts is well done, send it back",
  "the heat is real, please stand back",
  "someone walked into the kitchen voluntarily",
  "this chat is medium-rare and rising",
  "buddy got roasted and the receipts are public",
  "ts is pure flame on a tuesday",
  "the roast is so clean it deserves a chef's kiss",
  "ngl chat is doing numbers right now",
  "bro is being seasoned in real time",
  "lil bro the comeback better cook",
  "chat is on broil",
  "ts is grill-tier dialogue"
];

const ASSERTION_EXCLUDE_PATTERNS = [
  /\?/,
  /^(?:is|are|can|does|do|what|why|how|which|where|when)\b/,
  /\b(?:maybe|might|i think|think|idk|not sure|probably|seems|looks like)\b/
];
const STATUS_WORD_TO_RUNTIME = new Map([
  ["up", "UP"],
  ["working", "UP"],
  ["online", "UP"],
  ["down", "DOWN"],
  ["offline", "DOWN"],
  ["broken", "DOWN"],
  ["not working", "DOWN"]
]);

function trimExcerpt(text, max = 220) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length <= max) return cleaned || "(no text)";
  return `${cleaned.slice(0, max - 3)}...`;
}

function buildMessageUrl(message) {
  if (message?.url) return message.url;
  if (!message?.guildId || !message?.channelId || !message?.id) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

async function tryTimeoutMessageMember(member, durationMs, reason) {
  if (!member?.timeout || member.moderatable === false) {
    return {
      applied: false,
      reason: "bot cannot moderate that member"
    };
  }

  try {
    await member.timeout(durationMs, reason);
    return {
      applied: true,
      reason: `timed out for ${Math.round(durationMs / 1000)}s`
    };
  } catch (err) {
    return {
      applied: false,
      reason: err?.message || "timeout failed"
    };
  }
}

function buildRecentUserMessageKey(message) {
  if (!message?.guildId || !message?.channelId || !message?.author?.id) return null;
  return `${message.guildId}:${message.channelId}:${message.author.id}`;
}

function buildSuspiciousUserKey(message) {
  if (!message?.guildId || !message?.author?.id) return null;
  return `${message.guildId}:${message.author.id}`;
}

function buildSellingUserKey(message) {
  if (!message?.guildId || !message?.author?.id) return null;
  return `${message.guildId}:${message.author.id}`;
}

function hasBypassPermission(message) {
  return hasModerationBypassMessage(message);
}

async function hasManualWhitelistBypass(message) {
  const userId = message?.author?.id;
  if (!userId) return false;

  try {
    return await isModerationWhitelistedUser(userId);
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-whitelist-check", err?.message || err);
    return false;
  }
}

function getPosterLinkContext(message, now = Date.now()) {
  const userCreatedAt = Number(message?.author?.createdTimestamp || 0);
  const memberJoinedAt = Number(message?.member?.joinedTimestamp || 0);
  const accountAgeMs = userCreatedAt > 0 ? now - userCreatedAt : null;
  const memberAgeMs = memberJoinedAt > 0 ? now - memberJoinedAt : null;

  return {
    accountAgeMs,
    memberAgeMs,
    isNewAccount: Number.isFinite(accountAgeMs) && accountAgeMs >= 0 && accountAgeMs < NEW_ACCOUNT_LINK_SCRUTINY_MS,
    isNewMember: Number.isFinite(memberAgeMs) && memberAgeMs >= 0 && memberAgeMs < NEW_MEMBER_LINK_SCRUTINY_MS
  };
}

async function recordModerationStat(eventKey, now = Date.now()) {
  try {
    await recordDailyModerationEvent(eventKey, { at: now });
  } catch (err) {
    recordRuntimeEvent("warn", "daily-moderation-track", err?.message || err);
  }
}

function buildLocalAuditResult(localResult) {
  if (!localResult) return null;
  return {
    verdict: localResult.verdict,
    answer: localResult.verdict === true ? "TRUE" : localResult.verdict === false ? "FALSE" : "BORDERLINE",
    model: localResult.model || "local classifier",
    reason: localResult.reason || null,
    confidence: localResult.confidence,
    score: localResult.score
  };
}

function getSellingConfidenceTimeoutTier(confidence) {
  const numeric = Number(confidence || 0);
  return (SELLING_CONFIDENCE_TIMEOUT_TIERS || [])
    .filter((tier) => numeric > Number(tier?.threshold || 0) && Number(tier?.timeoutMs || 0) > 0)
    .sort((a, b) => Number(b.threshold || 0) - Number(a.threshold || 0))[0] || null;
}

function getSellingConfidenceTimeoutMs(confidence) {
  return Number(getSellingConfidenceTimeoutTier(confidence)?.timeoutMs || 0);
}

const { applyProfileMultiplier } = require("../scam-profile-signals");

function getConfirmedSignalConfidence(signal, verdictResult, fallback = 0, member = null) {
  const signalConfidence = Number(signal?.confidence || 0);
  const verdictConfidence = Number(verdictResult?.confidence || 0);

  let base;
  if (Number.isFinite(verdictConfidence) && verdictConfidence > 0) {
    base = clampConfidence(Math.max(signalConfidence, verdictConfidence, fallback));
  } else {
    base = clampConfidence(Math.max(signalConfidence, fallback));
  }

  // Profile multiplier: amplify confidence for fresh accounts / recent joiners,
  // capped so it can't fabricate a hit on its own. Mature accounts → 1.0×.
  if (member) {
    const { confidence } = applyProfileMultiplier(base, member);
    return clampConfidence(confidence);
  }
  return base;
}

async function recordScamAudit(message, {
  action,
  handled,
  signals,
  strongest,
  scamContext,
  localResult,
  aiResult,
  now = Date.now()
} = {}) {
  const candidate = strongest || signals?.[0] || null;
  try {
    const result = await recordScamDecisionAudit({
      createdAt: now,
      guildId: message.guildId || message.guild?.id || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      action,
      handled,
      candidateReason: candidate?.reason || null,
      candidateConfidence: candidate?.confidence || null,
      local: buildLocalAuditResult(localResult),
      ai: aiResult || null,
      messageContent: message.content || "",
      replyContent: scamContext?.repliedToMessage?.content || "",
      recentMessages: scamContext?.userMessages || []
    });
    return { auditId: result?.id || null };
  } catch (err) {
    recordRuntimeEvent("warn", "scam-audit", err?.message || err);
    return { auditId: null };
  }
}

function isAssertiveStatement(content) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  return !ASSERTION_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content) || pattern.test(normalized));
}

function normalizeSellingSourceText(content) {
  return foldConfusableText(content)
    .toLowerCase()
    .replace(SELL_MONEY_EMOJI_RE, " money ")
    .replace(/\b14ad1ng\b/g, " trading ")
    .replace(/\b4or\b/g, " for ")
    .replace(/\b4\b/g, " for ")
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "l")
    .replace(/0/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(SELL_NEUTRAL_WORD_RE, " ");
}

function repairSellingNormalizedText(text) {
  return String(text || "")
    .replace(/\bsae+l{1,3}i+n+g\b/g, "selling")
    .replace(/\bse+l{1,4}n+g\b/g, "selling")
    .replace(/\bse+i+n+g\b/g, "selling")
    .replace(/\bse\s+ing\b/g, "selling")
    .replace(/\bst+ell?ing\b/g, "selling")
    .replace(/\btrae+d+i+n+k\b/g, "trading")
    .replace(/\btra+b+i+n+[pg]\b/g, "trading")
    .replace(/\btra+i+g\b/g, "trading")
    .replace(/\btr+d+i+n+g\b/g, "trading")
    .replace(/\btr+d+n+g\b/g, "trading")
    .replace(/\btr+a?d+i+n+k\b/g, "trading")
    .replace(/\b14adlng\b/g, "trading")
    .replace(/\bakk?ounts?\b/g, "account")
    .replace(/\backounts?\b/g, "account")
    .replace(/\bconfg+z*\b/g, "config")
    .replace(/\bconfigz+\b/g, "config")
    .replace(/\bpriemium\b/g, "premium")
    .replace(/\bprm\b/g, "prem")
    .replace(/\bpre\b/g, "prem")
    .replace(/\bkcia\b/g, "kicia")
    .replace(/\bkh\b/g, "kicia")
    .replace(/\bkicka\b/g, "kicia");
}

function buildSellingSpacedText(content) {
  return repairSellingNormalizedText(normalizeSellingSourceText(content)
    .replace(/[^a-z0-9]+/g, " ")
    .trim());
}

function buildSellingCondensedText(content) {
  return repairSellingNormalizedText(normalizeSellingSourceText(content)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()).replace(/\s+/g, "");
}

function hasApproxToken(tokens, terms, threshold = 0.78) {
  return (tokens || []).some((token) =>
    token.length >= 3 &&
    getFuzzyTokenVariants(token).some((variant) =>
      terms.some((term) => similarity(variant, term) >= threshold)
    )
  );
}

function getFuzzyTokenVariants(token) {
  const raw = String(token || "");
  const variants = new Set([raw]);
  if (raw.includes("l")) variants.add(raw.replace(/l/g, "i"));
  if (raw.includes("i")) variants.add(raw.replace(/i/g, "l"));
  if (raw.includes("k")) variants.add(raw.replace(/k/g, "c"));
  if (raw.includes("c")) variants.add(raw.replace(/c/g, "k"));
  if (raw.includes("rn")) variants.add(raw.replace(/rn/g, "m"));
  if (raw.includes("vv")) variants.add(raw.replace(/vv/g, "w"));
  return [...variants].filter(Boolean);
}

function compactContainsApproxTerm(compact, terms, threshold = 0.72) {
  const source = String(compact || "");
  if (!source) return false;

  for (const term of terms || []) {
    const normalizedTerm = buildSellingCondensedText(term);
    if (!normalizedTerm || normalizedTerm.length < 3) continue;
    if (source.includes(normalizedTerm)) return true;

    const minLength = Math.max(3, normalizedTerm.length - 2);
    const maxLength = Math.min(source.length, normalizedTerm.length + 2);
    for (let size = minLength; size <= maxLength; size += 1) {
      for (let index = 0; index <= source.length - size; index += 1) {
        const window = source.slice(index, index + size);
        if (
          getFuzzyTokenVariants(window).some((variant) => similarity(variant, normalizedTerm) >= threshold)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function shouldUseCompactSellingMatch(content, spaced) {
  const raw = String(content || "");
  const normalized = String(spaced || "");
  if (!raw.trim()) return false;
  if (/[^\x00-\x7F]/.test(raw)) return true;
  if (/[|()[\]{}<>_.,;:~`"'\\/-]/.test(raw)) return true;
  if (/(?:\b[a-z0-9]\s+){3,}[a-z0-9]\b/i.test(raw)) return true;
  if (/\b(?:14ad1ng|14adlng|trd(?:ing)?|trding|sellin|selin|seing|slling|s311in|akkount|ackount|confg|configz|prm|kcia|cfk|figs?)\b/.test(normalized)) {
    return true;
  }
  return false;
}

function hasSuspiciousConfigAlias(spaced, { hasObfuscatedIntent, hasMarketSignal, hasPrivateHandoff } = {}) {
  if (SELL_CONFIG_ALIAS_RE.test(spaced)) return true;
  return Boolean(
    SELL_OBFUSCATED_CONFIG_ALIAS_RE.test(spaced) &&
    (hasObfuscatedIntent || hasMarketSignal || hasPrivateHandoff)
  );
}

function isSellPriceFollowUp(content) {
  const rawLower = String(content || "").toLowerCase().trim();
  if (!rawLower) return false;
  if (rawLower.includes("?")) return false;
  return SELL_PRICE_RE.test(` ${rawLower} `) || /^(?:price|prices|cheap)$/.test(rawLower);
}

function hasQuestionPunctuation(content) {
  return /\?\s*$/.test(String(content || "").trim());
}

function hasSafeSupportOrGameplayContext(spaced) {
  const text = String(spaced || "");
  return SAFE_SUPPORT_CONTEXT_RE.test(text) || SAFE_GAMEPLAY_CONTEXT_RE.test(text);
}

function hasActionableDealLanguage(spaced) {
  return ACTIONABLE_DEAL_LANGUAGE_RE.test(String(spaced || ""));
}

function hasConcreteItemForItemSignal(spaced, {
  hasMarketSignal = false,
  hasBroadIntent = false,
  hasPrivateHandoff = false
} = {}) {
  const text = String(spaced || "");
  if (!/\bfor\b/.test(text)) return false;
  if (hasSellAntiContext(text, text, text.replace(/\s+/g, ""))) return false;

  const item = "(?:kicia|kiciahook|premium|prem|prm|ue|config|configs|cfg|cfgs|account|accounts|acc|key|keys|license|licenses|robux|rbx|script|scripts|executor|executors|hvh|cfk|enhancement|enhancements)";
  const consideration = "(?:kicia|kiciahook|premium|prem|prm|ue|config|configs|cfg|cfgs|account|accounts|acc|key|keys|license|licenses|robux|rbx|money|usd|dollars?|bucks?|paypal|cashapp|crypto|nitro|volt)";
  const itemForItem = new RegExp(`\\b${item}\\b.{0,45}\\bfor\\b.{0,45}\\b${consideration}\\b`);
  const tradeVerb = /\b(?:trade|trading|swap|swapping|exchange|exchanging|sell|selling|sold|buying|wts|wtb|for sale)\b/.test(text);
  const moneyOrRobux = /\b(?:money|usd|dollars?|bucks?|paypal|cashapp|crypto|robux|rbx|nitro|volt)\b/.test(text);
  const enhancementForPremium = /\benhancements?\b.{0,45}\bfor\b.{0,45}\b(?:kicia|kiciahook|premium|prem|prm)\b/.test(text);

  return Boolean(
    itemForItem.test(text) &&
    (tradeVerb || hasBroadIntent || hasPrivateHandoff || hasMarketSignal || moneyOrRobux || enhancementForPremium)
  );
}

function hasSellAntiContext(rawLower, spaced, condensed) {
  const raw = String(rawLower || "");
  const spacedText = String(spaced || "");
  const compactText = String(condensed || "");
  return SELL_ANTI_PATTERNS.some((pattern) => pattern.test(raw) || pattern.test(spacedText)) ||
    SELL_CONTEXT_NEGATIVE_RE.test(spacedText) ||
    SELL_POLICY_NEGATIVE_CONDENSED_PATTERNS.some((pattern) => pattern.test(compactText));
}

function clampConfidence(value) {
  return Math.max(1, Math.min(99, Math.round(Number(value) || 1)));
}

function scoreSellingConfidence({
  content,
  spaced,
  condensed,
  hasExplicitOffer,
  hasBroadSellIntent,
  hasItemSignal,
  hasMarketSignal
}) {
  const raw = String(content || "");
  const rawLower = raw.toLowerCase();
  const tokens = spaced.split(/\s+/).filter(Boolean);
  const hasPrivateOrBio = PRIVATE_HANDOFF_RE.test(spaced);
  const useCompactMatch = shouldUseCompactSellingMatch(raw, spaced);
  if (!hasBroadSellIntent && !(hasItemSignal && (hasMarketSignal || hasPrivateOrBio))) return 0;

  const hasFuzzyIntent = hasApproxToken(tokens, SELL_FUZZY_INTENT_TERMS);
  const hasCompactIntent = useCompactMatch && compactContainsApproxTerm(condensed, SELL_FUZZY_INTENT_TERMS);
  const hasWantOffer = WANT_OFFER_RE.test(spaced);
  const hasQuestionTone =
    hasQuestionPunctuation(raw) ||
    MARKET_QUESTION_RE.test(spaced);
  const hasStrongIntent =
    SELL_STRONG_INTENT_RE.test(spaced) ||
    /\b(?:wts|wtb)\b/.test(spaced) ||
    /f+o+r+s+a+l+e+/.test(condensed) ||
    (useCompactMatch && SELL_CONDENSED_INTENT_RE.test(condensed)) ||
    hasFuzzyIntent;
  const hasCondensedIntent = useCompactMatch && SELL_CONDENSED_INTENT_RE.test(condensed);
  const hasPriceSignal = /\$\s*\d/.test(raw) || SELL_PRICE_RE.test(rawLower);
  const hasPrivateTradeSignal =
    hasPrivateOrBio &&
    /\b(?:buy|price|prices|offer|offers|paid|money|account|script|config|cfg|key|premium|prem|robux)\b/.test(spaced);

  let score = hasBroadSellIntent ? 35 : 44;
  if (hasExplicitOffer) score += 25;
  if (hasStrongIntent) score += 20;
  if (hasCompactIntent && !hasStrongIntent) score += 12;
  if (hasItemSignal) score += 18;
  if (hasMarketSignal) score += 15;
  if (hasPriceSignal) score += 20;
  if (hasCondensedIntent && !hasStrongIntent) score += 10;
  if (hasPrivateTradeSignal) score += 12;
  if (hasPrivateOrBio && hasItemSignal) score += 10;
  if (hasWantOffer) score += 18;
  if (hasQuestionTone && !hasWantOffer) score -= 35;
  if (MARKET_QUESTION_RE.test(spaced) && !hasWantOffer) score -= 15;

  return clampConfidence(score);
}

function detectSellingSignal(content) {
  const rawLower = String(content || "").toLowerCase();
  const spaced = buildSellingSpacedText(content);
  const condensed = buildSellingCondensedText(content);
  if (!spaced || !condensed) return null;
  const tokens = spaced.split(/\s+/).filter(Boolean);
  const useCompactMatch = shouldUseCompactSellingMatch(content, spaced);
  if (hasSellAntiContext(rawLower, spaced, condensed)) return null;
  if (isKiciaLegitPurchaseIntent([content])) return null;
  if (isSafePurchaseMethodQuestion([content])) return null;

  const hasExplicitOffer = SELL_OFFER_PATTERNS.some((pattern) => pattern.test(spaced));
  const hasFuzzyIntent = hasApproxToken(tokens, SELL_FUZZY_INTENT_TERMS);
  const hasCompactIntent = useCompactMatch && compactContainsApproxTerm(condensed, SELL_FUZZY_INTENT_TERMS);
  const hasExactIntent = SELL_BROAD_INTENT_RE.test(spaced);
  const hasCondensedIntent = useCompactMatch && SELL_CONDENSED_INTENT_RE.test(condensed);
  const hasObfuscatedIntent = (hasFuzzyIntent || hasCompactIntent || hasCondensedIntent) && !hasExactIntent;
  const hasBroadSellIntent =
    hasExplicitOffer ||
    hasExactIntent ||
    hasCondensedIntent ||
    hasFuzzyIntent ||
    hasCompactIntent;
  const hasItemSignal =
    SELL_ITEM_RE.test(spaced) ||
    (useCompactMatch && SELL_CONDENSED_ITEM_RE.test(condensed)) ||
    hasApproxToken(tokens, SELL_FUZZY_ITEM_TERMS) ||
    (useCompactMatch && compactContainsApproxTerm(condensed, SELL_FUZZY_ITEM_TERMS));
  const hasShortContextItem = SELL_SHORT_CONTEXT_ITEM_RE.test(spaced);
  const hasMarketSignal =
    SELL_MARKET_RE.test(rawLower) ||
    SELL_MARKET_RE.test(spaced) ||
    SELL_MONEY_EMOJI_RE.test(content) ||
    /\$\s*\d/.test(content) ||
    SELL_PRICE_RE.test(rawLower);
  const hasPriceSignal = /\$\s*\d/.test(content) || SELL_MONEY_EMOJI_RE.test(content) || SELL_PRICE_RE.test(rawLower);
  const hasQuestionTone = hasQuestionPunctuation(content) || MARKET_QUESTION_RE.test(spaced);
  const hasAvailabilityQuestion = RESOURCE_AVAILABILITY_QUESTION_RE.test(spaced);
  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(spaced);
  const hasWantOffer = WANT_OFFER_RE.test(spaced);
  const hasConfigAlias = hasSuspiciousConfigAlias(spaced, {
    hasObfuscatedIntent,
    hasMarketSignal,
    hasPrivateHandoff
  });
  const hasStrongIntent =
    SELL_STRONG_INTENT_RE.test(spaced) ||
    /\b(?:wts|wtb)\b/.test(spaced) ||
    /f+o+r+s+a+l+e+/.test(condensed) ||
    hasCondensedIntent ||
    hasFuzzyIntent;
  const hasEffectiveItemSignal = hasItemSignal || hasConfigAlias;
  const hasPrivateMarketItemSignal =
    hasPrivateHandoff &&
    hasEffectiveItemSignal &&
    (hasMarketSignal || /\b(?:paid|money|shop|store|hvh)\b/.test(spaced));
  const hasMarketItemSignal =
    hasEffectiveItemSignal &&
    hasMarketSignal &&
    (
      SELL_MONEY_EMOJI_RE.test(content) ||
      /\b(?:paid|money|cheap|shop|store|bucks?|dollars?|usd)\b/.test(spaced) ||
      SELL_PRICE_RE.test(rawLower)
    );
  const hasKiciaValueExchange = KICIA_VALUE_EXCHANGE_RE.test(spaced);
  const hasBarterLikeItemSignal =
    hasKiciaValueExchange ||
    (
      (hasEffectiveItemSignal || hasShortContextItem) &&
      hasConcreteItemForItemSignal(spaced, {
        hasMarketSignal,
        hasBroadIntent: hasBroadSellIntent,
        hasPrivateHandoff
      })
    );
  const hasSafeContext = hasSafeSupportOrGameplayContext(spaced);
  const hasJoinedObfuscatedDeal = useCompactMatch && hasObfuscatedIntent && hasCondensedIntent && hasEffectiveItemSignal;
  const hasActionableDeal = hasActionableDealLanguage(spaced) || hasExplicitOffer || hasPrivateMarketItemSignal || hasMarketItemSignal || hasBarterLikeItemSignal;

  if (hasSafeContext && !hasActionableDeal && !hasJoinedObfuscatedDeal) {
    return null;
  }

  if (
    hasExplicitOffer &&
    !hasEffectiveItemSignal &&
    !hasShortContextItem &&
    !hasPriceSignal &&
    !hasPrivateHandoff &&
    !hasPrivateMarketItemSignal &&
    !hasMarketItemSignal &&
    !hasBarterLikeItemSignal
  ) {
    return null;
  }

  if (!hasBroadSellIntent && !hasPrivateMarketItemSignal && !hasMarketItemSignal && !hasBarterLikeItemSignal) {
    return null;
  }

  // Single words like "selling" or loose questions are context candidates,
  // not deterministic moderation events.
  if (!hasExplicitOffer && !hasEffectiveItemSignal && !hasMarketSignal && !hasBarterLikeItemSignal) {
    return null;
  }
  if ((hasQuestionTone || hasAvailabilityQuestion) && !hasWantOffer && !hasPrivateHandoff && !SELL_PRICE_RE.test(rawLower)) {
    return null;
  }
  if (
    !hasExplicitOffer &&
    !hasPrivateHandoff &&
    !hasPrivateMarketItemSignal &&
    !hasMarketItemSignal &&
    !hasBarterLikeItemSignal &&
    !(hasEffectiveItemSignal && (hasMarketSignal || hasStrongIntent)) &&
    !(hasPriceSignal && hasStrongIntent && (hasEffectiveItemSignal || hasShortContextItem))
  ) {
    return null;
  }

  const confidence = scoreSellingConfidence({
    content,
    spaced,
    condensed,
    hasExplicitOffer,
    hasBroadSellIntent,
    hasItemSignal: hasEffectiveItemSignal || hasShortContextItem,
    hasMarketSignal
  }) || (hasKiciaValueExchange ? 82 : hasBarterLikeItemSignal ? 78 : 1);

  return {
    type: "selling",
    source: "local",
    confidence,
    reason: hasEffectiveItemSignal || hasMarketSignal
      ? "sell-related wording detected with sale context"
      : "sell-related wording detected"
  };
}

function getScamTradeTextFeatures(text) {
  const rawLower = String(text || "").toLowerCase();
  const spaced = buildSellingSpacedText(text);
  const condensed = buildSellingCondensedText(text);
  const tokens = spaced.split(/\s+/).filter(Boolean);
  const useCompactMatch = shouldUseCompactSellingMatch(text, spaced);
  const intentTokens = new Set(["sell", "selling", "seller", "sold", "buy", "buying", "buyer", "trade", "trading", "trader", "swap", "swapping", "exchange", "exchanging", "give", "giving", "offer", "offering", "wts", "wtb", "for", "sale"]);
  const objectishTokens = tokens.filter((token) => !intentTokens.has(token) && token.length > 1);
  const hasPriceSignal = /\$\s*\d/.test(text) || SELL_PRICE_RE.test(rawLower);
  const hasShortItemSignal = SELL_SHORT_CONTEXT_ITEM_RE.test(spaced);
  const hasFuzzyIntent = hasApproxToken(tokens, SELL_FUZZY_INTENT_TERMS);
  const hasCompactIntent = useCompactMatch && compactContainsApproxTerm(condensed, SELL_FUZZY_INTENT_TERMS);
  const hasExactIntent = SELL_BROAD_INTENT_RE.test(spaced);
  const hasCondensedIntent = useCompactMatch && SELL_CONDENSED_INTENT_RE.test(condensed);
  const hasObfuscatedIntent = (hasFuzzyIntent || hasCompactIntent || hasCondensedIntent) && !hasExactIntent;
  const hasFuzzyItem =
    hasApproxToken(tokens, SELL_FUZZY_ITEM_TERMS) ||
    (useCompactMatch && compactContainsApproxTerm(condensed, SELL_FUZZY_ITEM_TERMS));
  const baseProtectedItemSignal =
    SELL_ITEM_RE.test(spaced) ||
    (useCompactMatch && SELL_CONDENSED_ITEM_RE.test(condensed)) ||
    hasFuzzyItem;
  const hasConfigAlias = hasSuspiciousConfigAlias(spaced, {
    hasObfuscatedIntent,
    hasMarketSignal: SELL_MARKET_RE.test(rawLower) || SELL_MARKET_RE.test(spaced) || hasPriceSignal,
    hasPrivateHandoff: PRIVATE_HANDOFF_RE.test(spaced)
  });
  const hasProtectedItemSignal = baseProtectedItemSignal || hasConfigAlias;
  const hasDeicticDealSignal = /\b(?:this|that|it|one|thing|stuff|something)\b/.test(spaced);
  const hasBarterSignal =
    /\b(?:trade|trading|swap|swapping|exchange|exchanging|give|giving|offer|offering)\b.{0,80}\bfor\b/.test(spaced);
  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(spaced);
  const hasAvailabilityQuestion = RESOURCE_AVAILABILITY_QUESTION_RE.test(spaced);
  const hasOfferTone =
    /\b(?:you|u)\s+want\b/.test(spaced) ||
    /\b(?:want|need)\s+(?:it|this|one)\b/.test(spaced) ||
    WANT_OFFER_RE.test(spaced);
  const hasOfferMarketEvidence =
    SELL_MARKET_RE.test(rawLower) ||
    SELL_MARKET_RE.test(spaced) ||
    hasPriceSignal ||
    /\b(?:moneytoken|paid|cheap|cheaper|paypal|cashapp|crypto|robux|nitro|usd|eur|gbp|dollars?|bucks?|venmo|zelle|wts|wtb|sell|selling|sold|buy\s+(?:my|from\s+me)|trade|trading|swap|swapping|exchange|reseller|middleman|mm|for\s+sale|taking\s+offers)\b/.test(spaced);
  const hasGameplayPartnerLook =
    /\b(?:who(?:\s+wants?|\s+wanna|\s+wana|\s+down)?\s+(?:to\s+)?(?:hvh|legit\s+pvp|pvp|deathmatch|1v1|1v1s|matchmaking|match|ffa|rivals)|wanna\s+hvh|hvh\s+anyone|hvh\s+partner|hvh\s+match|hvh\s+session|need\s+hvh|looking\s+for\s+hvh|lf\s+hvh|hvh\s+plz|hvh\s+pls)\b/.test(spaced);
  const hasPrivatePurchaseSignal =
    hasPrivateHandoff &&
    /\b(?:buy|buying|purchase|price|prices|pay|payment|sell|selling|offer|offers|paid|money|shop|store)\b/.test(spaced) &&
    (hasProtectedItemSignal || hasShortItemSignal || hasDeicticDealSignal);
  const hasPrivateOfferSignal =
    hasPrivateHandoff &&
    (hasOfferTone || /\b(?:paid|money|shop|store)\b/.test(spaced)) &&
    (hasProtectedItemSignal || hasShortItemSignal || hasDeicticDealSignal) &&
    hasOfferMarketEvidence &&
    !hasGameplayPartnerLook;
  const hasPrivateResourceRequestSignal =
    hasPrivateHandoff &&
    (hasProtectedItemSignal || hasShortItemSignal) &&
    (
      hasAvailabilityQuestion ||
      /\b(?:send|drop|share|slide|give|need|want|looking\s+for|has|have|got)\b/.test(spaced)
    );
  const hasMarketSignal =
    SELL_MARKET_RE.test(rawLower) || SELL_MARKET_RE.test(spaced) || SELL_MONEY_EMOJI_RE.test(text) || hasPriceSignal;
  const hasKiciaValueExchangeSignal = KICIA_VALUE_EXCHANGE_RE.test(spaced);
  const hasProtectedItemForItemSignal =
    hasKiciaValueExchangeSignal ||
    (
      (hasProtectedItemSignal || hasShortItemSignal) &&
      hasConcreteItemForItemSignal(spaced, {
        hasMarketSignal,
        hasBroadIntent: hasExactIntent || hasCondensedIntent || hasFuzzyIntent || hasCompactIntent,
        hasPrivateHandoff
      })
    );
  return {
    rawLower,
    spaced,
    condensed,
    tokens,
    hasAnti: hasSellAntiContext(rawLower, spaced, condensed),
    hasExplicitOffer: SELL_OFFER_PATTERNS.some((pattern) => pattern.test(spaced)),
    hasBroadIntent: hasExactIntent || hasCondensedIntent || hasFuzzyIntent || hasCompactIntent,
    hasItemSignal: hasProtectedItemSignal,
    hasShortItemSignal,
    hasMarketSignal,
    hasPriceSignal: hasPriceSignal || SELL_MONEY_EMOJI_RE.test(text),
    hasPrivateHandoff,
    hasPrivatePurchaseSignal,
    hasPrivateOfferSignal,
    hasPrivateResourceRequestSignal,
    hasBarterSignal,
    hasKiciaValueExchangeSignal,
    hasProtectedItemForItemSignal,
    hasAvailabilityQuestion,
    hasJoinedObfuscatedDeal: useCompactMatch && hasObfuscatedIntent && hasCondensedIntent && hasProtectedItemSignal,
    hasDeicticDealSignal,
    hasQuestionTone: hasQuestionPunctuation(text) || MARKET_QUESTION_RE.test(spaced),
    hasOfferTone,
    hasSafeContext: hasSafeSupportOrGameplayContext(spaced),
    hasActionableDealLanguage: hasActionableDealLanguage(spaced),
    hasObjectishSignal: objectishTokens.length > 0
  };
}

function detectScamTradeCandidateContext(messageTexts, repliedToMessage = null) {
  const texts = (Array.isArray(messageTexts) ? messageTexts : [])
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
  if (!texts.length) return null;
  if (isKiciaLegitPurchaseIntent(texts)) return null;
  if (isSafePurchaseMethodQuestion(texts, repliedToMessage)) return null;
  if (isExplanationResponseIntent(texts, repliedToMessage)) return null;

  const combined = texts.join("\n");
  const combinedFeatures = getScamTradeTextFeatures(combined);
  if (combinedFeatures.hasAnti) return null;
  if (
    combinedFeatures.hasAvailabilityQuestion &&
    !combinedFeatures.hasActionableDealLanguage &&
    !combinedFeatures.hasPrivateHandoff &&
    !combinedFeatures.hasPriceSignal
  ) {
    return null;
  }
  if (
    combinedFeatures.hasSafeContext &&
    !combinedFeatures.hasActionableDealLanguage &&
    !combinedFeatures.hasJoinedObfuscatedDeal
  ) {
    return null;
  }

  const latest = texts[texts.length - 1] || "";
  const latestFeatures = getScamTradeTextFeatures(latest);
  const previousFeatures = texts.slice(0, -1).map(getScamTradeTextFeatures);
  const latestHasDealDetail =
    latestFeatures.hasItemSignal ||
    latestFeatures.hasShortItemSignal ||
    latestFeatures.hasPriceSignal ||
    latestFeatures.hasPrivateHandoff ||
    latestFeatures.hasOfferTone ||
    latestFeatures.hasPrivatePurchaseSignal ||
    latestFeatures.hasPrivateOfferSignal ||
    latestFeatures.hasPrivateResourceRequestSignal ||
    latestFeatures.hasBarterSignal ||
    latestFeatures.hasProtectedItemForItemSignal;
  const referenceText = repliedToMessage?.content || "";
  const referenceFeatures = getScamTradeTextFeatures(referenceText);
  const referenceAsksForLink =
    /\b(?:where|send|give|drop|link|download|site|get)\b/.test(referenceFeatures.spaced) &&
    /\b(?:link|download|executor|script|key|config|account|acc|site)\b/.test(referenceFeatures.spaced);

  if (
    latestFeatures.hasPrivateHandoff &&
    (referenceAsksForLink || referenceFeatures.hasItemSignal || referenceFeatures.hasMarketSignal)
  ) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: 72,
      reason: "private DM handoff in reply to a link/trade/support request"
    };
  }

  if (combinedFeatures.hasPrivatePurchaseSignal) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasItemSignal ? 86 : 74,
      reason: "private buy/sell handoff detected in recent message context"
    };
  }

  if (combinedFeatures.hasPrivateResourceRequestSignal) {
    return {
      type: "selling",
      source: "local_policy",
      requiresAi: false,
      confirmedByPolicy: true,
      confidence: 69,
      reason: "private config/resource handoff request detected"
    };
  }

  if (combinedFeatures.hasPrivateOfferSignal) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasItemSignal ? 82 : 72,
      reason: "private item/trade offer detected in recent message context"
    };
  }

  if (combinedFeatures.hasBarterSignal && (combinedFeatures.hasItemSignal || combinedFeatures.hasDeicticDealSignal)) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasItemSignal ? 82 : 64,
      reason: "possible barter/trade intent in recent message context"
    };
  }

  if (combinedFeatures.hasKiciaValueExchangeSignal) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: 82,
      reason: "Kicia premium/key value-exchange wording in recent message context"
    };
  }

  if (combinedFeatures.hasProtectedItemForItemSignal) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasMarketSignal || combinedFeatures.hasPrivateHandoff ? 86 : 78,
      reason: "protected item-for-item offer in recent message context"
    };
  }

  const combinedHasProtectedDealItem = combinedFeatures.hasItemSignal || combinedFeatures.hasShortItemSignal;
  const previousHasProtectedDealContext = previousFeatures.some((features) =>
    features.hasItemSignal ||
    features.hasShortItemSignal ||
    features.hasPrivateHandoff ||
    features.hasPrivatePurchaseSignal ||
    features.hasPrivateOfferSignal ||
    features.hasPrivateResourceRequestSignal ||
    features.hasBarterSignal ||
    features.hasProtectedItemForItemSignal
  );
  const latestIsOnlyPrice =
    latestFeatures.hasPriceSignal &&
    !latestFeatures.hasItemSignal &&
    !latestFeatures.hasShortItemSignal &&
    !latestFeatures.hasPrivateHandoff &&
    !latestFeatures.hasOfferTone &&
    !latestFeatures.hasPrivatePurchaseSignal &&
    !latestFeatures.hasPrivateOfferSignal &&
    !latestFeatures.hasPrivateResourceRequestSignal &&
    !latestFeatures.hasBarterSignal &&
    !latestFeatures.hasProtectedItemForItemSignal;
  const splitIntentAndItem =
    texts.length >= 2 &&
    (
      previousFeatures.some((features) => features.hasBroadIntent || features.hasExplicitOffer) &&
      latestHasDealDetail &&
      (
        combinedHasProtectedDealItem ||
        previousHasProtectedDealContext ||
        latestFeatures.hasPrivatePurchaseSignal ||
        latestFeatures.hasPrivateOfferSignal ||
        latestFeatures.hasPrivateResourceRequestSignal ||
        latestFeatures.hasBarterSignal
      ) &&
      !(latestIsOnlyPrice && !combinedHasProtectedDealItem)
    );
  if (splitIntentAndItem) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: 76,
      reason: "possible scam/trade offer split across recent messages"
    };
  }

  if (
    combinedFeatures.hasBroadIntent &&
    (
      combinedFeatures.hasItemSignal ||
      combinedFeatures.hasPrivatePurchaseSignal ||
      combinedFeatures.hasPrivateOfferSignal ||
      combinedFeatures.hasPrivateResourceRequestSignal ||
      combinedFeatures.hasBarterSignal ||
      combinedFeatures.hasProtectedItemForItemSignal ||
      (combinedFeatures.hasDeicticDealSignal && combinedFeatures.hasOfferTone) ||
      (combinedFeatures.hasPriceSignal && combinedHasProtectedDealItem)
    )
  ) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasPriceSignal || combinedFeatures.hasPrivateHandoff ? 86 : combinedFeatures.hasQuestionTone ? 54 : 72,
      reason: "possible scam/trade intent in recent message context"
    };
  }

  return null;
}

function detectProhibitedCommerceSignal(messageTexts, repliedToMessage = null) {
  const texts = (Array.isArray(messageTexts) ? messageTexts : [messageTexts])
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
  if (!texts.length) return null;
  if (isExplanationResponseIntent(texts, repliedToMessage)) return null;

  const result = detectProhibitedCommerce(texts);
  if (!result) return null;

  return {
    type: "selling",
    subtype: "prohibited_sale",
    source: "local_policy",
    requiresAi: false,
    confirmedByPolicy: true,
    confidence: result.confidence,
    reason: result.reason,
    policy: {
      model: "local-commerce-policy-v3",
      category: result.category,
      term: result.term,
      matched: result.matched,
      score: result.score
    }
  };
}

function detectContextualSellingSignal(messageTexts, repliedToMessage = null) {
  if (!Array.isArray(messageTexts) || !messageTexts.length) return null;

  const prohibitedSignal = detectProhibitedCommerceSignal(messageTexts, repliedToMessage);
  if (prohibitedSignal) return prohibitedSignal;

  const latest = String(messageTexts[messageTexts.length - 1] || "");
  if (!isSellPriceFollowUp(latest)) {
    return detectScamTradeCandidateContext(messageTexts, repliedToMessage);
  }

  const previousTexts = messageTexts
    .slice(0, -1)
    .map((text) => buildSellingSpacedText(text))
    .filter(Boolean);
  const previousFeatures = messageTexts
    .slice(0, -1)
    .map(getScamTradeTextFeatures);

  const hasStrongPriorIntent = previousTexts.some((text, index) =>
    SELL_STRONG_INTENT_RE.test(text) &&
    !previousFeatures[index]?.hasAnti
  );
  const hasActionablePriorObject = previousFeatures.some((features) =>
    features.hasItemSignal ||
    features.hasShortItemSignal ||
    features.hasPrivateHandoff ||
    features.hasPrivatePurchaseSignal ||
    features.hasPrivateOfferSignal ||
    features.hasBarterSignal
  );

  if (!hasStrongPriorIntent) return detectScamTradeCandidateContext(messageTexts, repliedToMessage);
  if (!hasActionablePriorObject) return null;

  return {
    type: "selling",
    source: "context",
    requiresAi: true,
    confidence: 86,
    reason: "sell offer completed across recent messages"
  };
}

function detectSuspiciousSignal(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;
  if (SUSPICIOUS_ANTI_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  for (const candidate of SUSPICIOUS_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return {
        type: "suspicious",
        reason: candidate.reason,
        label: candidate.label,
        confidence: candidate.confidence || 75
      };
    }
  }

  return null;
}

function detectRoastingSignal(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;
  if (ROASTING_IGNORE_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  for (const pattern of ROASTING_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        type: "roasting",
        reason: "playful roast-like wording detected"
      };
    }
  }

  return null;
}

function detectStatusFakeInfo(content, runtimeStatus) {
  if (!isAssertiveStatement(content)) return null;
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const patterns = [
    /^(?:kicia|kiciahook)(?:\s+status)?\s+is\s+(up|working|online|down|offline|broken|not working)$/,
    /^(?:kicia|kiciahook)\s+(up|working|online|down|offline|broken|not working)$/,
    /^status\s+is\s+(up|down)$/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const claimedStatus = STATUS_WORD_TO_RUNTIME.get(match[1]);
    if (!claimedStatus || claimedStatus === runtimeStatus) return null;

    return {
      type: "fake_info",
      reason: `claimed status is ${match[1]}, but runtime status is ${runtimeStatus.toLowerCase()}`
    };
  }

  return null;
}

function getExecutorAliases(kb) {
  return Object.keys(kb?.executorAliasIndex || {}).sort((a, b) => b.length - a.length);
}

function detectExecutorClaim(normalized, kb) {
  for (const alias of getExecutorAliases(kb)) {
    const checks = [
      [`${alias} is supported`, "positive_support"],
      [`${alias} supported`, "positive_support"],
      [`${alias} is unsupported`, "negative_support"],
      [`${alias} unsupported`, "negative_support"],
      [`${alias} works`, "positive_working"],
      [`${alias} working`, "positive_working"],
      [`${alias} works with kicia`, "positive_working"],
      [`${alias} works with kiciahook`, "positive_working"],
      [`${alias} does not work`, "negative_working"],
      [`${alias} doesnt work`, "negative_working"],
      [`${alias} not working`, "negative_working"],
      [`kicia supports ${alias}`, "positive_support"],
      [`kiciahook supports ${alias}`, "positive_support"],
      [`kicia does not support ${alias}`, "negative_support"],
      [`kiciahook does not support ${alias}`, "negative_support"],
      [`kicia doesnt support ${alias}`, "negative_support"],
      [`kiciahook doesnt support ${alias}`, "negative_support"]
    ];

    for (const [text, claimType] of checks) {
      if (normalized === text) {
        return {
          executor: kb.executorAliasIndex[alias],
          claimType
        };
      }
    }
  }

  return null;
}

function detectExecutorFakeInfo(content, kb) {
  if (!isAssertiveStatement(content) || !kb) return null;
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const claim = detectExecutorClaim(normalized, kb);
  if (!claim?.executor) return null;

  const { executor, claimType } = claim;
  const status = executor.status;

  if (claimType === "positive_support" && status === "unsupported") {
    return {
      type: "fake_info",
      reason: `${executor.name} is listed as unsupported in docs`
    };
  }

  if (claimType === "negative_support" && status === "supported") {
    return {
      type: "fake_info",
      reason: `${executor.name} is listed as supported in docs`
    };
  }

  if (claimType === "positive_working" && (status === "unsupported" || status === "temporarily_not_working")) {
    return {
      type: "fake_info",
      reason:
        status === "temporarily_not_working"
          ? `${executor.name} is listed as temporarily not working rn`
          : `${executor.name} is listed as unsupported in docs`
    };
  }

  if (claimType === "negative_working" && status === "supported") {
    return {
      type: "fake_info",
      reason: `${executor.name} is listed as supported in docs`
    };
  }

  return null;
}

function mightContainFakeInfo(content) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  if (!isAssertiveStatement(content)) return false;

  return (
    (
      /\b(?:kicia|kiciahook|status)\b/.test(normalized) &&
      /\b(?:up|down|working|offline|online|broken)\b/.test(normalized)
    ) ||
    /\b(?:supports?|supported|unsupported|works|working)\b/.test(normalized) ||
    /\b(?:does not work|doesnt work|not working)\b/.test(normalized)
  );
}

function detectFakeInfoSignal(content, { kb, runtimeStatus }) {
  const statusSignal = detectStatusFakeInfo(content, runtimeStatus);
  if (statusSignal) return statusSignal;
  return detectExecutorFakeInfo(content, kb);
}

function normalizeRaidSignature(content) {
  const cleaned = cleanText(content)
    .replace(/https?:\/\/\S+/gi, " url ")
    .replace(/discord\.gg\/\S+/gi, " invite ");
  const normalized = normalizeText(cleaned);
  if (!normalized) return null;
  if (normalized.length < 12) return null;
  if (normalized.split(/\s+/).filter(Boolean).length < 3) return null;
  return normalized;
}

function pruneRaidState(now = Date.now()) {
  for (const [key, entry] of raidBuckets.entries()) {
    entry.events = entry.events.filter((event) => now - event.at <= RAID_WINDOW_MS);
    if (!entry.events.length) raidBuckets.delete(key);
  }

  for (const [key, alertedAt] of lastRaidAlertAt.entries()) {
    if (now - alertedAt > RAID_ALERT_COOLDOWN_MS) {
      lastRaidAlertAt.delete(key);
    }
  }
}

function pruneRecentUserMessages(now = Date.now()) {
  for (const [key, entry] of recentUserMessages.entries()) {
    entry.messages = entry.messages.filter((message) => now - message.at <= SELL_CONTEXT_WINDOW_MS);
    if (!entry.messages.length) recentUserMessages.delete(key);
  }
}

function pruneSuspiciousUserState(now = Date.now()) {
  for (const [key, entry] of suspiciousUserBuckets.entries()) {
    entry.events = entry.events.filter((event) => now - event.at <= SUSPICIOUS_ALERT_WINDOW_MS);
    if (!entry.events.length) suspiciousUserBuckets.delete(key);
  }
}

function pruneSellingUserState(now = Date.now()) {
  for (const [key, entry] of sellingUserBuckets.entries()) {
    entry.events = entry.events.filter((event) => now - event.at <= SELLING_REPEAT_WINDOW_MS);
    if (!entry.events.length) sellingUserBuckets.delete(key);
  }
}

function getSuspiciousAction({ count, confidence }) {
  if (confidence > SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD) return "timeout";
  if (count >= SUSPICIOUS_TIMEOUT_THRESHOLD) return "timeout";
  if (count >= SUSPICIOUS_WARNING_THRESHOLD) return "warn";
  return "alert";
}

function pickPublicReplyLine(lines) {
  if (!Array.isArray(lines) || !lines.length) return "";
  return lines[Math.floor(Math.random() * lines.length)] || lines[0];
}

function buildSuspiciousPublicReply(state) {
  const displayCount = state?.highConfidence ? SUSPICIOUS_TIMEOUT_THRESHOLD : state?.count || 1;
  const hit = Math.max(1, Math.min(displayCount, SUSPICIOUS_TIMEOUT_THRESHOLD));
  const line = pickPublicReplyLine(SUSPICIOUS_PUBLIC_REPLIES_BY_HIT[hit - 1]);
  return `${line} (${hit}/${SUSPICIOUS_TIMEOUT_THRESHOLD})`;
}

function buildSellingPublicReply(signals = []) {
  return pickPublicReplyLine(
    hasProhibitedSaleSignal(signals)
      ? PROHIBITED_SALE_PUBLIC_REPLIES
      : SELLING_PUBLIC_REPLIES
  );
}

function buildRoastingPublicReply() {
  return pickPublicReplyLine(ROASTING_PUBLIC_REPLIES);
}

async function tryReplyModerationMessage(message, content, replyType) {
  const sent = await safeReply(message, {
    content,
    allowedMentions: { repliedUser: false }
  }).catch((err) => {
    recordRuntimeEvent("warn", `${replyType}-public-reply`, err?.message || err);
    return false;
  });

  return Boolean(sent);
}

function rememberSuspiciousMessage(message, signals, now = Date.now()) {
  const key = buildSuspiciousUserKey(message);
  const confidence = getMaxSignalConfidence(signals);
  const highConfidence = confidence > SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD;
  if (!key) {
    return {
      count: 1,
      confidence,
      highConfidence,
      action: highConfidence ? "timeout" : "alert",
      trigger: highConfidence
        ? `confidence ${confidence}% > ${SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD}%`
        : "below immediate-timeout confidence",
      events: []
    };
  }

  pruneSuspiciousUserState(now);
  const entry = suspiciousUserBuckets.get(key) || { events: [] };
  entry.events.push({
    at: now,
    channelId: message.channelId,
    messageId: message.id,
    url: buildMessageUrl(message),
    confidence,
    reasons: signals.map((signal) => signal.reason)
  });
  entry.events = entry.events.slice(-Math.max(SUSPICIOUS_TIMEOUT_THRESHOLD + 2, 5));
  suspiciousUserBuckets.set(key, entry);

  return {
    count: entry.events.length,
    confidence,
    highConfidence,
    action: getSuspiciousAction({ count: entry.events.length, confidence }),
    trigger: highConfidence
      ? `confidence ${confidence}% > ${SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD}%`
      : entry.events.length >= SUSPICIOUS_TIMEOUT_THRESHOLD
        ? `${entry.events.length} in ${formatDuration(SUSPICIOUS_ALERT_WINDOW_MS)}`
        : "below immediate-timeout confidence",
    events: [...entry.events]
  };
}

function getMaxSignalConfidence(signals) {
  return Math.max(
    0,
    ...(signals || []).map((signal) => Number(signal.confidence || 0))
  );
}

function getSellingRepeatThreshold(confidence) {
  return confidence < SELLING_LOW_CONFIDENCE_THRESHOLD
    ? SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD
    : SELLING_REPEAT_TIMEOUT_THRESHOLD;
}

function rememberSellingMessage(message, signals, now = Date.now()) {
  const confidence = getMaxSignalConfidence(signals);
  const confidenceTier = getSellingConfidenceTimeoutTier(confidence);
  const highConfidence = Boolean(confidenceTier);
  const repeatThreshold = getSellingRepeatThreshold(confidence);
  const key = buildSellingUserKey(message);
  const confidenceTrigger = highConfidence
    ? `confidence ${confidence}% > ${confidenceTier.threshold}% => timeout ${formatDuration(confidenceTier.timeoutMs)}`
    : "below immediate-timeout confidence";

  if (!key) {
    return {
      count: 1,
      confidence,
      highConfidence,
      repeatThreshold,
      durationMs: highConfidence ? confidenceTier.timeoutMs : null,
      action: highConfidence ? "timeout" : "alert",
      trigger: confidenceTrigger,
      events: []
    };
  }

  pruneSellingUserState(now);
  const entry = sellingUserBuckets.get(key) || { events: [] };
  entry.events.push({
    at: now,
    channelId: message.channelId,
    messageId: message.id,
    url: buildMessageUrl(message),
    confidence,
    reasons: signals.map((signal) => signal.reason)
  });
  entry.events = entry.events.slice(-Math.max(SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD + 2, 5));
  sellingUserBuckets.set(key, entry);

  const repeated = entry.events.length >= repeatThreshold;
  const action = highConfidence || repeated ? "timeout" : "alert";

  return {
    count: entry.events.length,
    confidence,
    highConfidence,
    repeatThreshold,
    durationMs: highConfidence ? confidenceTier.timeoutMs : null,
    action,
    trigger: highConfidence
      ? confidenceTrigger
      : repeated
        ? `${entry.events.length}/${repeatThreshold} scam/trade signals in ${formatDuration(SELLING_REPEAT_WINDOW_MS)}`
        : "below immediate-timeout confidence",
    events: [...entry.events]
  };
}

function cloneReplyContext(repliedToMessage) {
  if (!repliedToMessage?.content) return null;
  return {
    content: cleanText(repliedToMessage.content),
    authorId: repliedToMessage.authorId || null,
    authorLabel: repliedToMessage.authorLabel || "other user"
  };
}

function normalizeRecentMessageEntry(entry) {
  if (typeof entry === "string") {
    return {
      at: Date.now(),
      content: String(entry || ""),
      repliedToMessage: null,
      messageId: null,
      channelId: null,
      guildId: null,
      url: null,
      messageRef: null
    };
  }

  return {
    at: Number(entry?.at || Date.now()),
    content: String(entry?.content || ""),
    repliedToMessage: cloneReplyContext(entry?.repliedToMessage),
    messageId: entry?.messageId ? String(entry.messageId) : null,
    channelId: entry?.channelId ? String(entry.channelId) : null,
    guildId: entry?.guildId ? String(entry.guildId) : null,
    url: entry?.url ? String(entry.url) : null,
    messageRef: entry?.messageRef || null
  };
}

function getRecentMessageTexts(recentMessages) {
  return (recentMessages || [])
    .map((entry) => cleanText(typeof entry === "string" ? entry : entry?.content))
    .filter(Boolean)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
}

function clearRecentUserMessagesFor(message) {
  const key = buildRecentUserMessageKey(message);
  if (!key) return false;
  return recentUserMessages.delete(key);
}

function rememberRecentUserMessage(message, repliedToMessage = null, now = Date.now()) {
  const key = buildRecentUserMessageKey(message);
  if (!key) {
    return [{
      at: now,
      content: String(message?.content || ""),
      repliedToMessage: cloneReplyContext(repliedToMessage)
    }];
  }

  pruneRecentUserMessages(now);
  const entry = recentUserMessages.get(key) || { messages: [] };
  entry.messages.push({
    at: now,
    content: String(message.content || ""),
    repliedToMessage: cloneReplyContext(repliedToMessage),
    messageId: message.id || null,
    channelId: message.channelId || null,
    guildId: message.guildId || message.guild?.id || null,
    url: buildMessageUrl(message),
    messageRef: message
  });
  if (entry.messages.length > SELL_CONTEXT_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-SELL_CONTEXT_MAX_MESSAGES);
  }
  recentUserMessages.set(key, entry);
  return entry.messages.map(normalizeRecentMessageEntry);
}

async function resolveReferencedMessageContext(message) {
  if (!message?.reference?.messageId && !message?.fetchReference) return null;

  let referenced = null;
  if (typeof message.fetchReference === "function") {
    referenced = await message.fetchReference().catch(() => null);
  }

  if (!referenced && message.reference?.messageId && typeof message.channel?.messages?.fetch === "function") {
    referenced = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
  }

  const content = cleanText(referenced?.content || "");
  if (!content) return null;
  return {
    content,
    authorId: referenced.author?.id || null,
    authorLabel: referenced.member?.displayName || referenced.author?.username || referenced.author?.id || "other user"
  };
}

function buildScamAiContext({ message, recentMessages, repliedToMessage }) {
  const messageContexts = (recentMessages || [])
    .map(normalizeRecentMessageEntry)
    .map((entry) => ({
      content: cleanText(entry.content),
      repliedToMessage: cloneReplyContext(entry.repliedToMessage)
    }))
    .filter((entry) => entry.content)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
  const userMessages = getRecentMessageTexts(messageContexts);

  return {
    userId: message.author?.id || null,
    channelId: message.channelId || null,
    userMessages,
    messageContexts,
    repliedToMessage: repliedToMessage || null,
    currentMessageUrl: buildMessageUrl(message)
  };
}

function formatDiscordTimestamp(timestamp, style = "R") {
  const seconds = Math.floor(Math.max(0, Number(timestamp || 0)) / 1000);
  return `<t:${seconds}:${style}>`;
}

function getModerationReviewExpiresAt(now = Date.now(), timeoutMs = 0) {
  const actionMs = Math.max(0, Number(timeoutMs || 0));
  const reviewMs = actionMs > 0
    ? Math.min(actionMs, MODERATION_ACTION_REVIEW_MAX_MS)
    : MODERATION_ACTION_REVIEW_MAX_MS;
  return Math.max(now + 60_000, now + reviewMs);
}

function formatModerationActionReviewWindow(expiresAt) {
  return `${formatDiscordTimestamp(expiresAt, "R")} (${formatDiscordTimestamp(expiresAt, "f")})`;
}

function formatSignalReasonsForStorage(input) {
  const signals = Array.isArray(input) ? input : input ? [input] : [];
  const reasons = [];
  for (const signal of signals) {
    if (Array.isArray(signal?.reasons) && signal.reasons.length) {
      reasons.push(...signal.reasons);
    } else if (signal?.reason) {
      reasons.push(signal.reason);
    }
  }
  return reasons;
}

function normalizeModerationActionContext(recentMessages, fallbackMessage, now = Date.now()) {
  const entries = (recentMessages || [])
    .map(normalizeRecentMessageEntry)
    .filter((entry) => cleanText(entry.content));

  if (!entries.length && fallbackMessage) {
    entries.push({
      at: now,
      content: String(fallbackMessage.content || ""),
      repliedToMessage: null,
      messageId: fallbackMessage.id || null,
      channelId: fallbackMessage.channelId || null,
      guildId: fallbackMessage.guildId || fallbackMessage.guild?.id || null,
      url: buildMessageUrl(fallbackMessage)
    });
  }

  return entries.slice(-SELL_CONTEXT_MAX_MESSAGES).map((entry) => ({
    at: Number(entry.at || now),
    content: cleanText(entry.content),
    repliedToMessage: cloneReplyContext(entry.repliedToMessage),
    messageId: entry.messageId || null,
    channelId: entry.channelId || null,
    guildId: entry.guildId || null,
    url: entry.url || null
  }));
}

async function createModerationActionReview(message, {
  actionType,
  actionLabel,
  timeoutMs = 0,
  timeoutApplied = false,
  deleteApplied = false,
  dmSent = false,
  reasons = [],
  recentMessages = [],
  now = Date.now()
} = {}) {
  try {
    await cleanupExpiredModerationActions({ now });
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-action-cleanup", err?.message || err);
  }

  const expiresAt = getModerationReviewExpiresAt(now, timeoutApplied ? timeoutMs : 0);
  const actionId = await recordModerationAction({
    createdAt: now,
    expiresAt,
    guildId: message.guildId || message.guild?.id || null,
    channelId: message.channelId || null,
    messageId: message.id || null,
    messageUrl: buildMessageUrl(message),
    userId: message.author?.id || null,
    username: message.member?.displayName || message.author?.username || null,
    actionType,
    actionLabel,
    timeoutMs: timeoutApplied ? timeoutMs : 0,
    timeoutApplied,
    deleteApplied,
    dmSent,
    messageContent: message.content || "",
    recentMessages: normalizeModerationActionContext(recentMessages, message, now),
    reasons
  });

  return {
    actionId,
    expiresAt
  };
}

function withModerationLogTools(panel, {
  actionId,
  expiresAt,
  canRevert = false
} = {}) {
  if (!actionId) return panel;
  const reviewNote = canRevert
    ? `Context + undo controls expire ${formatModerationActionReviewWindow(expiresAt)}`
    : `Context review expires ${formatModerationActionReviewWindow(expiresAt)}`;

  const existingRows = Array.isArray(panel.components) ? panel.components : [];
  const toolRows = buildModerationLogButtonRows(actionId, { canRevert });

  if (panel.embed && typeof panel.embed.toJSON === "function" && panel.embed.data) {
    const existing = panel.embed.data.footer?.text || "";
    panel.embed.setFooter({ text: existing ? `${existing} · ${reviewNote}` : reviewNote });
  }

  return {
    ...panel,
    extra: [panel.extra, reviewNote].filter(Boolean).join(" | "),
    components: [...existingRows, ...toolRows].slice(0, 5)
  };
}

async function sendModerationLogWithTools(sendLog, guild, message, panel, {
  actionType,
  actionLabel,
  timeoutMs = 0,
  timeoutApplied = false,
  deleteApplied = false,
  dmSent = false,
  reasons = [],
  recentMessages = [],
  now = Date.now()
} = {}) {
  let logPanel = panel;

  try {
    const review = await createModerationActionReview(message, {
      actionType,
      actionLabel: actionLabel || panel.header,
      timeoutMs,
      timeoutApplied,
      deleteApplied,
      dmSent,
      reasons,
      recentMessages,
      now
    });
    logPanel = withModerationLogTools(panel, {
      actionId: review.actionId,
      expiresAt: review.expiresAt,
      canRevert: timeoutApplied
    });
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-action-record", err?.message || err);
  }

  return sendLog(guild, logPanel).catch(() => null);
}

function getRecentDeleteTargets(recentMessages, fallbackMessage, limit = MODERATION_DELETE_CONTEXT_LIMIT) {
  const entries = (recentMessages || [])
    .map(normalizeRecentMessageEntry)
    .filter((entry) => entry.messageRef?.delete || entry.messageId);

  if (!entries.length && fallbackMessage) {
    entries.push(normalizeRecentMessageEntry({
      at: Date.now(),
      content: fallbackMessage.content || "",
      messageId: fallbackMessage.id || null,
      channelId: fallbackMessage.channelId || null,
      guildId: fallbackMessage.guildId || fallbackMessage.guild?.id || null,
      url: buildMessageUrl(fallbackMessage),
      messageRef: fallbackMessage
    }));
  }

  const unique = new Map();
  for (const entry of entries.slice(-limit)) {
    const ref = entry.messageRef;
    const key = entry.guildId && entry.channelId && entry.messageId
      ? `${entry.guildId}:${entry.channelId}:${entry.messageId}`
      : ref
        ? `ref:${ref.id || unique.size}`
        : `unknown:${unique.size}`;
    unique.set(key, {
      ...entry,
      messageRef: ref
    });
  }

  return [...unique.values()];
}

function buildDeletePlanSummary(recentMessages, fallbackMessage, shouldDelete) {
  if (!shouldDelete) {
    return {
      queued: false,
      count: 0,
      text: "not needed"
    };
  }

  const count = getRecentDeleteTargets(recentMessages, fallbackMessage).length || 1;
  return {
    queued: true,
    count,
    text: `queued ${count} msg${count === 1 ? "" : "s"}`
  };
}

async function deleteRecentUserMessagesAfterLog(recentMessages, fallbackMessage, {
  enabled = true,
  scope = "moderation-delete"
} = {}) {
  if (!enabled) {
    return {
      queued: false,
      total: 0,
      deleted: 0,
      failed: 0,
      text: "not needed",
      failures: []
    };
  }

  const targets = getRecentDeleteTargets(recentMessages, fallbackMessage);
  const failures = [];
  let deleted = 0;

  for (const target of targets) {
    const message = target.messageRef;
    if (!message?.delete) {
      failures.push({
        messageId: target.messageId || null,
        reason: "message delete unavailable"
      });
      continue;
    }

    try {
      await message.delete();
      deleted += 1;
    } catch (err) {
      failures.push({
        messageId: target.messageId || message.id || null,
        reason: err?.message || "delete failed"
      });
    }
  }

  if (failures.length) {
    recordRuntimeEvent("warn", scope, failures.map((failure) => failure.reason).join("; "));
  }

  return {
    queued: true,
    total: targets.length,
    deleted,
    failed: failures.length,
    failures,
    text: `deleted ${deleted}/${targets.length}`
  };
}

function observeRaidMessage(message, now = Date.now()) {
  if (!message?.inGuild?.()) return null;

  pruneRaidState(now);
  const signature = normalizeRaidSignature(message.content);
  if (!signature) return null;

  const key = `${message.guildId}:${message.channelId}:${signature}`;
  const entry = raidBuckets.get(key) || { events: [] };
  entry.events.push({
    at: now,
    userId: message.author?.id,
    url: buildMessageUrl(message)
  });
  raidBuckets.set(key, entry);

  const uniqueUsers = new Set(entry.events.map((event) => event.userId).filter(Boolean));
  if (uniqueUsers.size < RAID_MIN_DISTINCT_USERS) return null;
  const lastAlertAt = lastRaidAlertAt.get(key);
  if (lastAlertAt && now - lastAlertAt < RAID_ALERT_COOLDOWN_MS) return null;

  lastRaidAlertAt.set(key, now);
  return {
    type: "raid",
    reason: `${uniqueUsers.size} users repeated near-identical messages inside ${Math.round(RAID_WINDOW_MS / 1000)}s`,
    signature,
    uniqueUsers: uniqueUsers.size,
    sampleUrl: entry.events[entry.events.length - 1]?.url || null
  };
}

function buildPrimaryAlertHeader(signals) {
  if (signals.some((signal) => signal.type === "blocked_link")) return "Blocked Link Alert";
  if (signals.some((signal) => signal.type === "selling")) return "Scam/Trade Alert";
  if (signals.some((signal) => signal.type === "suspicious")) return "Suspicious Message Alert";
  return "Fake Info Alert";
}

function buildSignalAlertPanel(message, signals) {
  const link = buildMessageUrl(message);
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const reasons = signals.map((s) => `- ${s.reason}`).join("\n");

  return {
    header: buildPrimaryAlertHeader(signals),
    author: { name: displayName, iconURL: avatar || undefined },
    fields: [
      { name: "User", value: `<@${message.author?.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Jump", value: link ? `[→ Open](${link})` : "—", inline: true },
      { name: "Why", value: reasons },
      { name: "Message", value: trimExcerpt(message.content) }
    ],
    color: WARN
  };
}

function hasProhibitedSaleSignal(signals) {
  return (signals || []).some((signal) => signal.subtype === "prohibited_sale");
}

function getSellingActionType(signals) {
  return hasProhibitedSaleSignal(signals) ? "prohibited_sale" : "scam_trade";
}

function getSellingTimeoutReason(signals) {
  return hasProhibitedSaleSignal(signals)
    ? "prohibited sale behavior in chat"
    : "scam/trade behavior in chat";
}

function getSellingModerationStatKey(signals, action) {
  const prefix = hasProhibitedSaleSignal(signals) ? "prohibited_sale" : "selling";
  return action === "timeout" ? `${prefix}_timeout` : `${prefix}_alert`;
}

function buildSellingDmPayload({ message, signals, state, durationMs }) {
  const isProhibitedSale = hasProhibitedSaleSignal(signals);
  const summary = terminalBlock([
    `${ansi("[", "red")}${ansi("ACTION", "red", { bold: true })}${ansi("]", "red")} ${ansi("timeout", "white")}     ${ansi(formatDuration(durationMs), "yellow", { bold: true })}`,
    `${ansi("[", "red")}${ansi("DELETE", "red", { bold: true })}${ansi("]", "red")} ${ansi("messages", "white")}    ${ansi("removed", "red")}`,
    `${ansi("[", "yellow")}${ansi("NOTICE", "yellow", { bold: true })}${ansi("]", "yellow")} ${ansi("staff", "white")}       ${ansi("notified", "cyan")}`
  ]);
  return {
    embeds: [
      buildPanel({
        header: isProhibitedSale ? "Prohibited Sale Timeout" : "Scam/Trade Timeout",
        body: [
          isProhibitedSale
            ? "Your recent messages looked like a prohibited-goods sale."
            : "Your recent messages looked like scam/trade activity.",
          summary
        ].join("\n\n"),
        fields: [
          kpi("TIMEOUT", formatDuration(durationMs)),
          kpi("DELETED", "yes"),
          kpi("STAFF", "notified"),
          { name: "NEXT STEP", value: "If this was a mistake, contact a staff member in the server.", inline: false }
        ],
        color: DANGER,
        author: brandAuthor("MODERATION · TIMEOUT")
      })
    ]
  };
}

function formatDeleteSummary(deleteResult) {
  if (!deleteResult) return "not needed";
  if (deleteResult.text) return deleteResult.text;
  if (deleteResult.deleted) return "ok";
  return deleteResult.reason || "not needed";
}

function formatSellingEvidence(message, recentMessages = []) {
  const entries = normalizeModerationActionContext(recentMessages, message)
    .filter((entry) => cleanText(entry.content))
    .slice(-SELL_CONTEXT_MAX_MESSAGES);

  if (entries.length <= 1) {
    return trimExcerpt(message.content);
  }

  return entries
    .map((entry, index) => `${index + 1}. ${trimExcerpt(entry.content, 150)}`)
    .join("\n");
}

function buildSellingLogPanel({
  message,
  signals,
  state,
  deleteResult,
  timeoutResult,
  dmSent,
  durationMs,
  recentMessages = [],
  auditId = null
}) {
  const isProhibitedSale = hasProhibitedSaleSignal(signals);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const deleteText = formatDeleteSummary(deleteResult);
  const isTimeout = state.action === "timeout";
  const aiLines = formatAiVerdictLines(signals);
  const header = isProhibitedSale
    ? isTimeout ? "Prohibited Sale Timeout" : "Prohibited Sale Alert"
    : isTimeout ? "Scam/Trade Timeout" : "Scam/Trade Alert";

  const dialSignals = signals.slice(0, 5).map((s) => ({
    name: String(s.reason || "signal"),
    weight: Math.max(0, Math.min(100, Number(s.confidence) || 0))
  }));

  const channelLabel = message.channel?.name ? `#${message.channel.name}` : "#unknown";
  const userTag = message.author?.tag || message.author?.username || displayName;
  const caseId = auditId
    ? `S-${String(auditId).slice(-4).toUpperCase()}`
    : `S-${String(Date.now()).slice(-4)}`;
  const actionLine = isTimeout
    ? `Message removed · user timed out ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} · delete ${deleteText} · dm ${dmSent ? "sent" : "failed"}`
    : `Logged for review · delete ${deleteText}`;

  const triggerLine = String(state.trigger || "watch window");
  const evidenceList = buildSellingEvidenceList(message, recentMessages);

  const built = ui.buildScamEmbed({
    channel: channelLabel,
    userTag: displayName,
    userId: message.author?.id || "0",
    message: message.content || "",
    score: Math.max(0, Math.min(100, Math.round(state.confidence))),
    signals: dialSignals,
    action: actionLine,
    caseId,
    title: header,
    trigger: triggerLine,
    aiVerdict: aiLines || null,
    evidence: evidenceList
  });

  const panel = {
    embed: built.embeds[0],
    files: built.files,
    header,
    color: isTimeout ? DANGER : WARN
  };

  if (auditId) panel.components = buildScamReviewButtonRows(auditId);
  return panel;
}

function buildSellingEvidenceList(message, recentMessages = []) {
  const entries = normalizeModerationActionContext(recentMessages, message)
    .filter((entry) => cleanText(entry.content))
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
  const list = entries.length <= 1
    ? [trimExcerpt(message.content)]
    : entries.map((entry) => trimExcerpt(entry.content, 150));
  return list.filter(Boolean);
}

function formatAiVerdictLines(signals) {
  const lines = (signals || [])
    .map((signal) => signal.ai)
    .filter(Boolean)
    .map((ai) => {
      const detail = ai.skipped ? ` (${ai.skipped})` : "";
      const reason = ai.reason ? ` - ${ai.reason}` : "";
      return `- ${ai.model || "Gemini"}: ${ai.answer || "NO_ANSWER"}${detail}${reason}`;
    });
  return lines.length ? lines.join("\n") : "";
}

function buildClassifierVerdictResult(result) {
  if (!result) return null;
  const answer = result.verdict === true ? "TRUE" : result.verdict === false ? "FALSE" : "BORDERLINE";
  return {
    attempted: false,
    verdict: result.verdict,
    answer,
    model: result.model || "local classifier",
    skipped: result.verdict === null ? "borderline" : "local_confident",
    confidence: result.confidence,
    score: result.score,
    reason: result.reason
  };
}

function buildScamAiClearedLogPanel({ message, candidateSignal, aiResult }) {
  const link = buildMessageUrl(message);
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";

  return {
    header: "Scam AI Cleared",
    author: { name: displayName, iconURL: avatar || undefined },
    body: "prefilter sent this for a verdict — classifier returned false",
    fields: [
      { name: "User", value: `<@${message.author?.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Jump", value: link ? `[→ Open](${link})` : "—", inline: true },
      { name: "AI Answer", value: aiResult.answer || "FALSE", inline: true },
      { name: "Model", value: aiResult.model || "Gemini", inline: true },
      { name: "Candidate", value: candidateSignal.reason },
      { name: "Message", value: trimExcerpt(message.content) }
    ],
    color: TEAL
  };
}

async function replyToSellingMessage(message, signals = []) {
  return tryReplyModerationMessage(message, buildSellingPublicReply(signals), "scam-trade");
}

function buildFakeInfoPublicReply(signals = []) {
  const reason = signals.find((signal) => signal.reason)?.reason;
  return [
    "## False info bro!",
    reason ? `Kicia docs/runtime disagree: ${reason}.` : null
  ].filter(Boolean).join("\n");
}

async function replyToFakeInfoMessage(message, signals) {
  return tryReplyModerationMessage(message, buildFakeInfoPublicReply(signals), "fake-info");
}

async function replyToRoastingMessage(message) {
  return tryReplyModerationMessage(message, buildRoastingPublicReply(), "roasting");
}

function formatBlockedLinkReasons(signal) {
  const reasons = signal.reasons?.length ? signal.reasons : [signal.reason || "risky link detected"];
  return reasons.map((reason) => `- ${reason}`).join("\n");
}

function buildBlockedLinkUserPayload({ message, signal, durationMs }) {
  const shownLinks = signal.blockedLinks
    .slice(0, 3)
    .map((entry) => `- ${entry.raw}`)
    .join("\n");
  const isTimeout = signal.action === "timeout";

  return {
    embeds: [
      buildPanel({
        header: isTimeout ? "Link Timeout" : "Link Warning",
        body: isTimeout
          ? `Timed out for ${formatDuration(durationMs)} — that link looked high-risk.`
          : "That link was removed — it looked risky.",
        fields: [
          { name: "Threat Level", value: signal.threatLevel, inline: true },
          { name: "Channel", value: `<#${message.channelId}>`, inline: true },
          { name: "Why", value: formatBlockedLinkReasons(signal) },
          { name: "Blocked Link(s)", value: shownLinks || "—" },
          { name: "Note", value: "docs links, staff-added trusted links, safe domains, and gif links are always allowed." }
        ],
        color: WARN
      })
    ]
  };
}

function buildBlockedLinkLogPanel({ message, signal, deleteResult, timeoutResult, dmSent, durationMs }) {
  const link = deleteResult?.queued ? null : buildMessageUrl(message);
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const isScamPulse = (signal.reasons || []).some((r) => /FishFish|PhishTank|Scam Pulse/i.test(r));
  const shownLinks = signal.blockedLinks.slice(0, 5).map((e) => `- ${e.raw}`).join("\n");
  const deleteText = formatDeleteSummary(deleteResult);
  const actionText = `${signal.action} · timeout ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} · delete ${deleteText} · dm ${dmSent ? "✓" : "✗"}`;

  return {
    header: isScamPulse && signal.action === "timeout"
      ? timeoutResult.applied ? "Scam Pulse Timeout" : "Scam Pulse Alert"
      : signal.action === "timeout"
        ? timeoutResult.applied ? "Blocked Link Timeout" : "Blocked Link Alert"
        : signal.action === "warn"
          ? "Blocked Link Warning"
          : "Link Review",
    author: { name: displayName, iconURL: avatar || undefined },
    fields: [
      { name: "User", value: `<@${message.author?.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Threat", value: `${signal.threatLevel} (${signal.confidence || 0}%)`, inline: true },
      { name: "Action", value: actionText, inline: true },
      { name: "Blocked Count", value: String(signal.blockedCount), inline: true },
      link ? { name: "Jump", value: `[→ Open](${link})`, inline: true } : null,
      { name: "Why", value: formatBlockedLinkReasons(signal) },
      { name: "Blocked Links", value: shownLinks || "—" },
      { name: "Evidence", value: trimExcerpt(message.content) }
    ].filter(Boolean),
    color: timeoutResult.applied ? DANGER : WARN
  };
}

function formatSignalReasons(signals) {
  return signals
    .map((signal) => `- ${signal.reason}`)
    .join("\n");
}

function buildSuspiciousDmPayload({ message, signals, action, durationMs, count, confidence = 0, highConfidence = false }) {
  const isTimeout = action === "timeout";

  return {
    embeds: [
      buildPanel({
        header: isTimeout ? "Suspicious Message Timeout" : "Suspicious Message Warning",
        body: isTimeout
          ? "One or more of your recent messages were flagged as suspicious."
          : "One of your recent messages was flagged as suspicious.",
        fields: [
          isTimeout
            ? { name: "Timeout", value: formatDuration(durationMs), inline: true }
            : { name: "Action", value: "message removed", inline: true },
          { name: "Staff Notified", value: "yes", inline: true },
          { name: "Next Step", value: "If this was a mistake, contact a staff member in the server." }
        ],
        color: isTimeout ? DANGER : WARN
      })
    ]
  };
}

function buildSuspiciousLogPanel({ message, signals, state, timeoutResult, dmSent, durationMs, deleteResult = null, auditId = null }) {
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const deleteText = formatDeleteSummary(deleteResult);
  const actionLineHuman = state.action === "timeout"
    ? `Timed out ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} · delete ${deleteText} · dm ${dmSent ? "sent" : "failed"}`
    : state.action === "warn"
      ? `DM warning ${dmSent ? "sent" : "failed"} · delete ${deleteText}`
      : "Logged for review";
  const actionLineLegacy = state.action === "timeout"
    ? `timeout ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} · delete ${deleteText} · dm ${dmSent ? "✓" : "✗"}`
    : state.action === "warn"
      ? `delete ${deleteText} · dm warning ${dmSent ? "✓" : "✗"}`
      : "log only";

  const dialSignals = (signals || []).slice(0, 5).map((s) => ({
    name: String(s.reason || "signal"),
    weight: Math.max(0, Math.min(100, Number(s.confidence) || 0))
  }));

  const channelLabel = message.channel?.name ? `#${message.channel.name}` : "#unknown";
  const caseId = auditId
    ? `S-${String(auditId).slice(-4).toUpperCase()}`
    : `S-${String(Date.now()).slice(-4)}`;
  const header = state.action === "timeout"
    ? "Suspicious Message Timeout"
    : state.action === "warn"
      ? "Suspicious Message Warning"
      : "Suspicious Message Alert";

  const built = ui.buildScamEmbed({
    channel: channelLabel,
    userTag: displayName,
    userId: message.author?.id || "0",
    message: message.content || "",
    score: Math.max(0, Math.min(100, Math.round(Number(state.confidence) || 0))),
    signals: dialSignals,
    action: `${actionLineHuman} · ${actionLineLegacy}`,
    caseId,
    title: header,
    trigger: String(state.trigger || "watch window"),
    evidence: [trimExcerpt(message.content)]
  });

  const panel = {
    embed: built.embeds[0],
    files: built.files,
    header,
    color: state.action === "timeout" ? DANGER : WARN
  };
  if (auditId) panel.components = buildScamReviewButtonRows(auditId);
  return panel;
}

function buildToxicityShadowReviewPanel({ message, result, forms }) {
  const link = buildMessageUrl(message);
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";

  return {
    header: "Toxicity Shadow Review",
    author: { name: displayName, iconURL: avatar || undefined },
    body: "shadow model scored high — deterministic rules didn't act",
    fields: [
      { name: "User", value: `<@${message.author?.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Jump", value: link ? `[→ Open](${link})` : "—", inline: true },
      { name: "Model", value: result.model || "toxicity model", inline: true },
      { name: "Score", value: `${result.label || "unknown"} ${result.confidence || 0}%`, inline: true },
      { name: "Mixed Scripts", value: forms?.scriptMix?.hasMixedScripts ? forms.scriptMix.usedScripts.join(", ") : "no", inline: true },
      { name: "Normalized", value: trimExcerpt(forms?.normalized || "", 220) },
      { name: "Evidence", value: trimExcerpt(message.content) }
    ],
    color: WARN
  };
}

function buildRaidAlertPanel(message, raidAlert) {
  const link = raidAlert.sampleUrl || buildMessageUrl(message);

  return {
    header: "Raid Alert",
    body: "copy-paste wave or coordinated spam detected",
    fields: [
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Unique Users", value: String(raidAlert.uniqueUsers), inline: true },
      link ? { name: "Jump", value: `[→ Sample](${link})`, inline: true } : null,
      { name: "Pattern", value: trimExcerpt(raidAlert.signature, 180) }
    ].filter(Boolean),
    color: DANGER
  };
}

function collectContentSignals(content, { kb, runtimeStatus } = {}) {
  const signals = [];
  const prohibitedCommerceSignal = detectProhibitedCommerceSignal([content]);
  if (prohibitedCommerceSignal) signals.push(prohibitedCommerceSignal);

  const sellingSignal = detectSellingSignal(content);
  if (sellingSignal) signals.push(sellingSignal);

  const suspiciousSignal = detectSuspiciousSignal(content);
  if (suspiciousSignal) signals.push(suspiciousSignal);

  return signals;
}

function mightContainLink(content) {
  return extractUrlsFromText(content).length > 0;
}

async function handleBlockedLinkMessage(message, signal, {
  sendLog = sendLogPanel,
  timeoutMs = LINK_MODERATION_TIMEOUT_MS,
  now = Date.now(),
  recentMessages = []
} = {}) {
  const action = signal.action || "timeout";
  const effectiveTimeoutMs = Number(signal.timeoutMs || 0) > 0 ? Number(signal.timeoutMs) : timeoutMs;
  const shouldDelete = action !== "review";
  const deletePlan = buildDeletePlanSummary(recentMessages, message, shouldDelete);
  const timeoutResult = action === "timeout"
    ? await tryTimeoutMessageMember(message.member, effectiveTimeoutMs, "high-risk link")
    : { applied: false, reason: action === "warn" ? "warning only" : "not needed" };
  const dmSent = action === "timeout" || action === "warn"
    ? await safeSend(message.author, buildBlockedLinkUserPayload({
        message,
        signal,
        durationMs: effectiveTimeoutMs
      }))
    : false;

  if (action === "timeout" && !timeoutResult.applied) {
    recordRuntimeEvent("warn", "blocked-link-timeout", timeoutResult.reason);
  }
  await recordModerationStat(
    action === "timeout"
      ? timeoutResult.applied ? "blocked_link_timeout" : "blocked_link_alert"
      : action === "warn"
        ? "blocked_link_warning"
        : "blocked_link_review",
    now
  );

  const panel = buildBlockedLinkLogPanel({
    message,
    signal,
    deleteResult: deletePlan,
    timeoutResult,
    dmSent,
    durationMs: effectiveTimeoutMs
  });
  await sendModerationLogWithTools(sendLog, message.guild, message, panel, {
    actionType: "blocked_link",
    actionLabel: panel.header,
    timeoutMs: effectiveTimeoutMs,
    timeoutApplied: timeoutResult.applied,
    deleteApplied: shouldDelete,
    dmSent,
    reasons: formatSignalReasonsForStorage(signal),
    recentMessages,
    now
  });
  await deleteRecentUserMessagesAfterLog(recentMessages, message, {
    enabled: shouldDelete,
    scope: "blocked-link-delete"
  });

  return action !== "review";
}

async function handleSellingMessage(message, signals, {
  sendLog = sendLogPanel,
  timeoutMs = SELLING_TIMEOUT_MS,
  now = Date.now(),
  replyPublic = true,
  recentMessages = [],
  auditId = null
} = {}) {
  const state = rememberSellingMessage(message, signals, now);
  const effectiveTimeoutMs = Number(state.durationMs || 0) > 0 ? Number(state.durationMs) : timeoutMs;
  const publicReplySent = replyPublic
    ? await replyToSellingMessage(message, signals)
    : false;
  const deletePlan = buildDeletePlanSummary(recentMessages, message, true);
  let timeoutResult = {
    applied: false,
    reason: "not needed"
  };
  let dmSent = false;

  if (state.action === "timeout") {
    timeoutResult = await tryTimeoutMessageMember(message.member, effectiveTimeoutMs, getSellingTimeoutReason(signals));
    dmSent = await safeSend(message.author, buildSellingDmPayload({
      message,
      signals,
      state,
      durationMs: effectiveTimeoutMs
    }));
    if (!timeoutResult.applied) {
      recordRuntimeEvent("warn", "selling-timeout", timeoutResult.reason);
    }
  }

  await recordModerationStat(getSellingModerationStatKey(signals, state.action), now);
  const panel = buildSellingLogPanel({
    message,
    signals,
    state,
    deleteResult: deletePlan,
    timeoutResult,
    dmSent,
    durationMs: effectiveTimeoutMs,
    recentMessages,
    auditId
  });
  await sendModerationLogWithTools(sendLog, message.guild, message, panel, {
    actionType: getSellingActionType(signals),
    actionLabel: panel.header,
    timeoutMs: effectiveTimeoutMs,
    timeoutApplied: timeoutResult.applied,
    deleteApplied: true,
    dmSent,
    reasons: formatSignalReasonsForStorage(signals),
    recentMessages,
    now
  });
  const deleteResult = await deleteRecentUserMessagesAfterLog(recentMessages, message, {
    enabled: true,
    scope: "selling-delete"
  });

  return {
    ...state,
    deleteResult,
    publicReplySent
  };
}

function buildDecomposedClassifierResult(decomposed, signals) {
  const fired = decomposed.signals || [];
  const reason = decomposed.label === "decomposed"
    ? `decomposed signals: ${fired.join(", ")}`
    : decomposed.label;
  return {
    verdict: decomposed.score >= 50,
    confidence: Math.max(0, Math.min(99, decomposed.score)),
    score: decomposed.score / 100,
    reason,
    stage: "decomposed",
    model: "kicia-decomposed-v1",
    decomposed
  };
}

async function confirmScamTradeSignals(message, signals, scamContext, {
  classifyScam = classifyScamContextWithGemini,
  sendLog = sendLogPanel,
  sendClearLog,
  now = Date.now()
} = {}) {
  if (!signals.length) return { signals: [], auditId: null };
  const sendClearedLog = sendClearLog || (sendLog === sendLogPanel ? sendIgnoreLogPanel : sendLog);

  const strongest = signals.reduce(
    (best, signal) => (!best || (signal.confidence || 0) > (best.confidence || 0) ? signal : best),
    null
  );
  const policyConfirmedSignals = signals.filter((signal) => signal.confirmedByPolicy);
  if (policyConfirmedSignals.length) {
    const policyConfidence = getMaxSignalConfidence(policyConfirmedSignals);
    const policyResult = {
      verdict: true,
      confidence: policyConfidence,
      score: policyConfidence / 100,
      reason: "High-confidence local policy matched prohibited commerce.",
      model: "local-commerce-policy-v3"
    };
    const policyVerdict = buildClassifierVerdictResult(policyResult);
    const confirmedSignals = policyConfirmedSignals.map((signal) => ({
      ...signal,
      confidence: getConfirmedSignalConfidence(signal, policyVerdict, 0, message.member),
      reason: `policy-confirmed unsafe commerce: ${signal.reason}`,
      ai: policyVerdict
    }));
    const { auditId } = await recordScamAudit(message, {
      action: "local_policy_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult: policyResult,
      now
    });
    return { signals: confirmedSignals, auditId };
  }

  const decomposed = classifyScamDecomposed({
    rawTexts: Array.isArray(scamContext?.userMessages) ? scamContext.userMessages : [],
    repliedToContent: scamContext?.repliedToMessage?.content || ""
  });
  const decomposedClassifier = buildDecomposedClassifierResult(decomposed, signals);
  const strongestSignalConfidence = signals.reduce(
    (max, signal) => Math.max(max, signal.confidence || 0),
    0
  );

  const decomposedSignalCount = Array.isArray(decomposed.signals) ? decomposed.signals.length : 0;
  const decomposedConfidentlyClear =
    decomposed.label === "negation_or_report" ||
    (decomposed.score < 50 && decomposedSignalCount <= 1);

  if (
    decomposedConfidentlyClear &&
    strongestSignalConfidence < 88 &&
    !signals.some((signal) => signal.confirmedByPolicy)
  ) {
    await sendClearedLog(message.guild, buildScamAiClearedLogPanel({
      message,
      candidateSignal: strongest,
      aiResult: decomposedClassifier
    })).catch(() => null);
    await recordScamAudit(message, {
      action: "decomposed_clear",
      handled: false,
      signals,
      strongest,
      scamContext,
      localResult: decomposedClassifier,
      now
    });
    return { signals: [], auditId: null };
  }

  if (decomposed.hardConfirm && decomposed.score >= 85) {
    const decomposedVerdict = buildClassifierVerdictResult(decomposedClassifier);
    const confirmedSignals = signals.map((signal) => ({
      ...signal,
      confidence: getConfirmedSignalConfidence(signal, decomposedVerdict, 0, message.member),
      reason: `decomposed-confirmed scam/trade intent: ${signal.reason}`,
      ai: decomposedVerdict
    }));
    const { auditId } = await recordScamAudit(message, {
      action: "decomposed_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult: decomposedClassifier,
      now
    });
    return { signals: confirmedSignals, auditId };
  }

  const needsAi = signals.some((signal) => signal.requiresAi) || Boolean(strongest);
  if (!needsAi) return { signals, auditId: null };

  const localResult = await classifyScamContextLocallyAsync(scamContext, { strongestSignal: strongest });
  const localVerdict = buildClassifierVerdictResult(localResult);
  if (localResult?.verdict === true && (localResult.confidence || 0) > SELLING_CONFIDENCE_TIMEOUT_THRESHOLD) {
    const confirmedSignals = signals.map((signal) => ({
      ...signal,
      confidence: getConfirmedSignalConfidence(signal, localVerdict, 0, message.member),
      reason: `classifier-confirmed scam/trade intent: ${signal.reason}`,
      ai: localVerdict
    }));
    const { auditId } = await recordScamAudit(message, {
      action: "local_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult,
      now
    });
    return { signals: confirmedSignals, auditId };
  }

  const hasAiRequiredSignals = signals.some((signal) => signal.requiresAi);
  if (
    localResult?.verdict === false &&
    (localResult.confidence || 0) >= 92 &&
    (!hasAiRequiredSignals || localResult.stage === "policy" || (localResult.confidence || 0) >= 97)
  ) {
    await sendClearedLog(message.guild, buildScamAiClearedLogPanel({
      message,
      candidateSignal: strongest,
      aiResult: localVerdict
    })).catch(() => null);
    await recordScamAudit(message, {
      action: "local_false_clear",
      handled: false,
      signals,
      strongest,
      scamContext,
      localResult,
      now
    });
    return { signals: [], auditId: null };
  }

  const deterministicSignals = signals.filter((signal) =>
    !signal.requiresAi &&
    (signal.confidence || 0) > SELLING_CONFIDENCE_TIMEOUT_THRESHOLD
  );
  if (deterministicSignals.length) {
    const deterministicConfidence = getMaxSignalConfidence(deterministicSignals);
    const deterministicResult = {
      verdict: true,
      confidence: deterministicConfidence,
      score: deterministicConfidence / 100,
      reason: "High-confidence deterministic scam/trade signal.",
      model: "local-kicia-policy-v3"
    };
    const deterministicVerdict = buildClassifierVerdictResult(deterministicResult);
    const confirmedSignals = deterministicSignals.map((signal) => ({
      ...signal,
      confidence: getConfirmedSignalConfidence(signal, deterministicVerdict, 0, message.member),
      reason: `local-confirmed scam/trade intent: ${signal.reason}`,
      ai: deterministicVerdict
    }));
    const { auditId } = await recordScamAudit(message, {
      action: "local_deterministic_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult: deterministicResult,
      now
    });
    return { signals: confirmedSignals, auditId };
  }

  const aiResult = await classifyScam(scamContext, { now });
  if (aiResult?.verdict === true) {
    const confirmedSignals = signals.map((signal) => ({
      ...signal,
      confidence: getConfirmedSignalConfidence(signal, aiResult, 0, message.member),
      reason: `AI-confirmed scam/trade intent: ${signal.reason}`,
      ai: aiResult
    }));
    const { auditId } = await recordScamAudit(message, {
      action: "ai_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult,
      aiResult,
      now
    });
    return { signals: confirmedSignals, auditId };
  }

  if (aiResult?.verdict === false) {
    await sendClearedLog(message.guild, buildScamAiClearedLogPanel({
      message,
      candidateSignal: strongest,
      aiResult
    })).catch(() => null);
    await recordScamAudit(message, {
      action: "ai_false_clear",
      handled: false,
      signals,
      strongest,
      scamContext,
      localResult,
      aiResult,
      now
    });
    return { signals: [], auditId: null };
  }

  if (aiResult?.attempted && aiResult.skipped && aiResult.skipped !== "missing_key") {
    recordRuntimeEvent("warn", "scam-ai", aiResult.error || aiResult.skipped);
  }

  // Local development or missing AI key keeps the deterministic guard working.
  if (!aiResult?.attempted && aiResult?.skipped === "missing_key") {
    const fallbackSignals = signals.filter((signal) => !signal.requiresAi || (signal.confidence || 0) > SELLING_CONFIDENCE_TIMEOUT_THRESHOLD);
    const { auditId } = await recordScamAudit(message, {
      action: "missing_key_fallback",
      handled: Boolean(fallbackSignals.length),
      signals: fallbackSignals.length ? fallbackSignals : signals,
      strongest,
      scamContext,
      localResult,
      aiResult,
      now
    });
    return { signals: fallbackSignals, auditId: fallbackSignals.length ? auditId : null };
  }

  // If Gemini is configured but unavailable/rate-limited, only act on very
  // strong deterministic evidence. Ambiguous scam candidates wait for AI.
  const fallbackSignals = signals.filter((signal) => !signal.requiresAi && (signal.confidence || 0) > SELLING_CONFIDENCE_TIMEOUT_THRESHOLD);
  const { auditId } = await recordScamAudit(message, {
    action: aiResult?.skipped ? `ai_${aiResult.skipped}` : "ai_no_verdict",
    handled: Boolean(fallbackSignals.length),
    signals: fallbackSignals.length ? fallbackSignals : signals,
    strongest,
    scamContext,
    localResult,
    aiResult,
    now
  });
  return { signals: fallbackSignals, auditId: fallbackSignals.length ? auditId : null };
}

async function handleSuspiciousMessage(message, signals, {
  sendLog = sendLogPanel,
  timeoutMs = SUSPICIOUS_TIMEOUT_MS,
  highConfidenceTimeoutMs = SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS,
  now = Date.now(),
  recentMessages = []
} = {}) {
  const state = rememberSuspiciousMessage(message, signals, now);
  const effectiveTimeoutMs = state.highConfidence ? highConfidenceTimeoutMs : timeoutMs;
  const publicReplySent = await tryReplyModerationMessage(
    message,
    buildSuspiciousPublicReply(state),
    "suspicious"
  );
  let dmSent = false;
  let timeoutResult = {
    applied: false,
    reason: "not needed"
  };
  const shouldDelete = state.action === "timeout" || state.action === "warn";
  const deletePlan = buildDeletePlanSummary(recentMessages, message, shouldDelete);

  const { auditId } = await recordScamAudit(message, {
    action: `suspicious_${state.action}`,
    handled: state.action === "timeout" || state.action === "warn",
    signals,
    strongest: null,
    scamContext: null,
    localResult: null,
    aiResult: null,
    now
  });

  if (state.action === "timeout") {
    timeoutResult = await tryTimeoutMessageMember(
      message.member,
      effectiveTimeoutMs,
      state.highConfidence ? "high-confidence suspicious message" : "repeated suspicious messages"
    );
    dmSent = await safeSend(message.author, buildSuspiciousDmPayload({
      message,
      signals,
      action: state.action,
      durationMs: effectiveTimeoutMs,
      count: state.count,
      confidence: state.confidence,
      highConfidence: state.highConfidence
    }));

    if (!timeoutResult.applied) {
      recordRuntimeEvent("warn", "suspicious-timeout", timeoutResult.reason);
    }
  } else if (state.action === "warn") {
    dmSent = await safeSend(message.author, buildSuspiciousDmPayload({
      message,
      signals,
      action: state.action,
      durationMs: effectiveTimeoutMs,
      count: state.count,
      confidence: state.confidence,
      highConfidence: state.highConfidence
    }));
  }
  await recordModerationStat(
    state.action === "warn" ? "suspicious_warning" : `suspicious_${state.action}`,
    now
  );

  const panel = buildSuspiciousLogPanel({
    message,
    signals,
    state,
    timeoutResult,
    dmSent,
    durationMs: effectiveTimeoutMs,
    deleteResult: deletePlan,
    auditId: (state.action === "timeout" || state.action === "warn") ? auditId : null
  });
  await sendModerationLogWithTools(sendLog, message.guild, message, panel, {
    actionType: "suspicious",
    actionLabel: panel.header,
    timeoutMs: effectiveTimeoutMs,
    timeoutApplied: timeoutResult.applied,
    deleteApplied: shouldDelete,
    dmSent,
    reasons: formatSignalReasonsForStorage(signals),
    recentMessages,
    now
  });
  const deleteResult = await deleteRecentUserMessagesAfterLog(recentMessages, message, {
    enabled: shouldDelete,
    scope: "suspicious-delete"
  });

  return {
    ...state,
    publicReplySent,
    deleteResult
  };
}

async function maybeHandleModerationWatch(message, {
  kb,
  runtimeStatus,
  fetchKbFn = fetchKb,
  classifyScam = classifyScamContextWithGemini,
  classifyToxicityShadow = maybeClassifyToxicityShadow,
  checkThreatIntel,
  sendLog = sendLogPanel,
  sendClearLog,
  now = Date.now()
} = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;
  if (hasBypassPermission(message)) return false;
  if (await hasManualWhitelistBypass(message)) return false;

  try {
    const repliedToMessage = await resolveReferencedMessageContext(message);
    const recentMessageEntries = rememberRecentUserMessage(message, repliedToMessage, now);
    const recentMessages = getRecentMessageTexts(recentMessageEntries);
    const scamContext = buildScamAiContext({ message, recentMessages: recentMessageEntries, repliedToMessage });
    let resolvedKb = kb || null;
    const hasLink = mightContainLink(message.content);
    if (!resolvedKb && hasLink) {
      resolvedKb = await fetchKbFn().catch(() => null);
    }

    if (hasLink && resolvedKb) {
      const trustedLinks = await listTrustedLinks().catch((err) => {
        recordRuntimeEvent("warn", "trusted-link-list", err?.message || err);
        return [];
      });
      const blockedLinkSignal = await detectBlockedLinkSignalAsync(message.content, {
        kb: resolvedKb,
        trustedLinks,
        posterContext: getPosterLinkContext(message, now),
        checkThreatIntel
      });
      if (blockedLinkSignal) {
        const linkHandled = await handleBlockedLinkMessage(message, blockedLinkSignal, {
          sendLog,
          now,
          recentMessages: recentMessageEntries
        });
        if (linkHandled) {
          clearRecentUserMessagesFor(message);
          return true;
        }
      }
    }

    const signals = collectContentSignals(message.content, {
      kb: resolvedKb,
      runtimeStatus: runtimeStatus || getRuntimeStatus()
    });
    const suspiciousSignals = signals.filter((signal) => signal.type === "suspicious");
    const contentSignals = signals.filter((signal) => signal.type !== "suspicious");
    const shadowForms = buildNormalizedTextForms(message.content);
    const shouldRunShadow =
      shadowForms.scriptMix.hasMixedScripts || shadowForms.scriptMix.hadDefaultIgnorable;
    const toxicityShadow = await classifyToxicityShadow(message.content, {
      candidate: shouldRunShadow
    }).catch((err) => {
      recordRuntimeEvent("warn", "toxicity-shadow-classify", err?.message || err);
      return {
        attempted: true,
        skipped: "error",
        error: err?.message || String(err)
      };
    });

    if (
      !contentSignals.some((signal) => signal.type === "selling") &&
      !suspiciousSignals.length
    ) {
      const contextualSellingSignal = detectContextualSellingSignal(recentMessages, repliedToMessage);
      if (contextualSellingSignal) {
        contentSignals.push(contextualSellingSignal);
      }
    }

    let publicReplySent = false;
    const sellingSignals = contentSignals.filter((signal) => signal.type === "selling");
    const otherContentSignals = contentSignals.filter((signal) => signal.type !== "selling");

    const { signals: confirmedSellingSignals, auditId: sellingAuditId } = sellingSignals.length
      ? await confirmScamTradeSignals(message, sellingSignals, scamContext, {
          classifyScam,
          sendLog,
          sendClearLog,
          now
        })
      : { signals: [], auditId: null };

    if (confirmedSellingSignals.length) {
      const state = await handleSellingMessage(message, confirmedSellingSignals, {
        sendLog,
        now,
        replyPublic: !suspiciousSignals.length,
        recentMessages: recentMessageEntries,
        auditId: sellingAuditId
      });
      clearRecentUserMessagesFor(message);
      publicReplySent = publicReplySent || state.publicReplySent;
    }

    const alertableContentSignals = otherContentSignals.filter((signal) => signal.type !== "fake_info");
    if (alertableContentSignals.length) {
      await sendLog(message.guild, buildSignalAlertPanel(message, alertableContentSignals));
    }

    if (
      toxicityShadow?.attempted &&
      !toxicityShadow.skipped &&
      Number(toxicityShadow.confidence || 0) >= 85
    ) {
      await sendLog(message.guild, buildToxicityShadowReviewPanel({
        message,
        result: toxicityShadow,
        forms: shadowForms
      })).catch(() => null);
      await recordModerationStat("toxicity_shadow_review", now);
    }

    if (suspiciousSignals.length) {
      const state = await handleSuspiciousMessage(message, suspiciousSignals, {
        sendLog,
        now,
        recentMessages: recentMessageEntries
      });
      clearRecentUserMessagesFor(message);
      publicReplySent = publicReplySent || state.publicReplySent;
    }

    if (!confirmedSellingSignals.length && !suspiciousSignals.length) {
      const roastingSignal = detectRoastingSignal(message.content);
      if (roastingSignal) {
        await replyToRoastingMessage(message);
        return true;
      }
    }

    const raidAlert = observeRaidMessage(message);
    if (raidAlert) {
      await sendLog(message.guild, buildRaidAlertPanel(message, raidAlert));
      await recordModerationStat("raid_alert", now);
    }

    if (confirmedSellingSignals.length || suspiciousSignals.length || publicReplySent) return true;
  } catch (err) {
    console.warn("Moderation watcher failed:", err.message);
    recordRuntimeEvent("warn", "moderation-watch", err?.message || err);
  }

  return false;
}

function parseModerationLogInteraction(customId) {
  const raw = String(customId || "");
  if (raw.startsWith(MODLOG_VIEW_PREFIX)) {
    return {
      type: "view",
      actionId: raw.slice(MODLOG_VIEW_PREFIX.length)
    };
  }
  if (raw.startsWith(MODLOG_REVERT_PREFIX)) {
    return {
      type: "revert",
      actionId: raw.slice(MODLOG_REVERT_PREFIX.length)
    };
  }
  return null;
}

function canUseModerationLogTools(interaction) {
  return canUseEmojiCommands({
    author: interaction?.user,
    member: interaction?.member
  });
}

function buildInteractionPayload(panel, { ephemeral = true } = {}) {
  const payload = {
    embeds: [buildPanel(panel)],
    allowedMentions: { parse: [] }
  };
  if (ephemeral) payload.ephemeral = true;
  return payload;
}

async function replyToModerationLogInteraction(interaction, panel) {
  if (interaction?.deferred || interaction?.replied) {
    await interaction.editReply?.(buildInteractionPayload(panel, { ephemeral: false })).catch(() => null);
    return true;
  }
  await interaction.reply?.(buildInteractionPayload(panel)).catch(() => null);
  return true;
}

async function deferModerationLogInteraction(interaction) {
  if (interaction?.deferred || interaction?.replied || !interaction?.deferReply) return false;
  await interaction.deferReply({ ephemeral: true }).catch(() => null);
  return true;
}

async function disableModerationLogButtons(interaction, actionId) {
  await interaction?.message?.edit?.({
    components: buildModerationLogButtonRows(actionId, {
      canRevert: false,
      disabled: true
    })
  }).catch(() => null);
}

async function resolveActionChannel(guild, channelId) {
  if (!guild?.channels || !channelId) return null;
  const cached = guild.channels.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild.channels.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

function asMessageArray(messages) {
  if (!messages) return [];
  if (Array.isArray(messages)) return messages;
  if (typeof messages.values === "function") return [...messages.values()];
  if (messages.cache && typeof messages.cache.values === "function") return [...messages.cache.values()];
  return [];
}

async function fetchVisibleUserMessages(guild, action) {
  const channel = await resolveActionChannel(guild, action.channelId);
  if (!channel?.messages?.fetch) return [];
  const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return asMessageArray(fetched)
    .filter((entry) => entry?.author?.id === action.userId)
    .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0))
    .slice(-MODERATION_CONTEXT_VIEW_LIMIT);
}

function formatCapturedActionMessages(action) {
  const entries = Array.isArray(action?.recentMessages) ? action.recentMessages.slice(-SELL_CONTEXT_MAX_MESSAGES) : [];
  if (!entries.length) return "none captured";

  return entries.map((entry, index) => {
    const when = entry.at ? formatDiscordTimestamp(entry.at, "R") : "captured";
    const id = entry.messageId ? ` | id ${entry.messageId}` : "";
    const jump = !action.deleteApplied && entry.url ? ` | [jump](${entry.url})` : "";
    const reply = entry.repliedToMessage?.content
      ? `\n  reply: ${entry.repliedToMessage.authorLabel || "other user"} - ${trimExcerpt(entry.repliedToMessage.content, 130)}`
      : "";
    return `${index + 1}. ${when}${id}${jump}\n   ${trimExcerpt(entry.content, 170)}${reply}`;
  }).join("\n");
}

function formatVisibleActionMessages(messages) {
  if (!messages.length) return "no visible recent messages found in that channel";
  return messages.map((entry, index) => {
    const when = entry.createdTimestamp ? formatDiscordTimestamp(entry.createdTimestamp, "R") : "recent";
    const jump = entry.url ? ` [jump](${entry.url})` : "";
    return `${index + 1}. ${when}${jump} - ${trimExcerpt(entry.content || "(no text)", 170)}`;
  }).join("\n");
}

function buildActionMessagesPanel(action, visibleMessages) {
  return {
    header: "User Message Context",
    fields: [
      { name: "User", value: action.userId ? `<@${action.userId}>` : action.username || "unknown", inline: true },
      action.channelId ? { name: "Channel", value: `<#${action.channelId}>`, inline: true } : null,
      { name: "Original Action", value: action.actionLabel, inline: true },
      { name: "Review Window", value: `closes ${formatModerationActionReviewWindow(action.expiresAt)}` },
      action.messageUrl && !action.deleteApplied ? { name: "Original Jump", value: `[→ Open](${action.messageUrl})` } : null,
      { name: "Stored Trigger", value: trimExcerpt(action.messageContent || "(no text)", 220) },
      { name: "Saved Evidence", value: formatCapturedActionMessages(action) },
      { name: "Still Visible", value: formatVisibleActionMessages(visibleMessages) }
    ].filter(Boolean),
    color: INFO
  };
}

function buildModerationActionExpiredPanel() {
  return {
    header: "Review Window Closed",
    body: "that log review record expired or was already resolved, so the buttons have been retired",
    color: WARN
  };
}

async function resolveActionMember(guild, userId) {
  if (!guild?.members || !userId) return null;
  const cached = guild.members.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof guild.members.fetch === "function") {
    return guild.members.fetch(userId).catch(() => null);
  }
  return null;
}

async function resolveActionUser(interaction, action, member) {
  if (member?.send || member?.user?.send) return member.user || member;
  if (interaction?.client?.users?.fetch && action.userId) {
    return interaction.client.users.fetch(action.userId).catch(() => null);
  }
  return null;
}

function buildRevertUserPayload({ action, actor }) {
  const actorLabel = actor?.id ? `<@${actor.id}>` : actor?.username || actor?.tag || "staff";
  return {
    embeds: [
      buildPanel({
        header: "Timeout Cleared",
        body: `Your timeout was cleared by ${actorLabel}. Sorry for the wrong call.`,
        fields: action.channelId ? [
          { name: "Original Channel", value: `<#${action.channelId}>`, inline: true }
        ] : [],
        color: SUCCESS
      })
    ],
    allowedMentions: { parse: [] }
  };
}

function buildRevertLogPanel({ action, actor, dmSent }) {
  return {
    header: "Moderation Action Reverted",
    body: "staff reverted a moderation timeout from the log controls",
    fields: [
      { name: "User", value: action.userId ? `<@${action.userId}>` : action.username || "unknown", inline: true },
      { name: "Reverted By", value: actor?.id ? `<@${actor.id}>` : actor?.username || "staff", inline: true },
      action.channelId ? { name: "Channel", value: `<#${action.channelId}>`, inline: true } : null,
      { name: "Original Action", value: action.actionLabel, inline: true },
      { name: "Original Timeout", value: formatDuration(action.timeoutMs || 0), inline: true },
      { name: "User DM", value: dmSent ? "sent" : "not sent", inline: true },
      action.messageUrl ? { name: "Original Jump", value: `[→ Open trigger](${action.messageUrl})` } : null
    ].filter(Boolean),
    color: SUCCESS
  };
}

async function handleModerationLogView(interaction, actionId, { now = Date.now() } = {}) {
  const action = await getModerationAction(actionId, { now });
  if (!action) {
    await disableModerationLogButtons(interaction, actionId);
    await replyToModerationLogInteraction(interaction, buildModerationActionExpiredPanel());
    return true;
  }

  const visibleMessages = await fetchVisibleUserMessages(interaction.guild, action);
  await replyToModerationLogInteraction(interaction, buildActionMessagesPanel(action, visibleMessages));
  return true;
}

async function handleModerationLogRevert(interaction, actionId, {
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  await deferModerationLogInteraction(interaction);
  const action = await getModerationAction(actionId, { now });
  if (!action) {
    await disableModerationLogButtons(interaction, actionId);
    await replyToModerationLogInteraction(interaction, buildModerationActionExpiredPanel());
    return true;
  }

  if (!action.timeoutApplied) {
    await replyToModerationLogInteraction(interaction, {
      header: "Nothing Reversible Stored",
      body: "this log has context to review, but no active timeout was stored. Deleted messages cannot be restored from Discord.",
      color: WARN
    });
    return true;
  }

  const member = await resolveActionMember(interaction.guild, action.userId);
  if (!member?.timeout) {
    await replyToModerationLogInteraction(interaction, {
      header: "Could Not Revert",
      body: "i could not fetch that member or clear their timeout. staff may need to check Discord manually.",
      color: DANGER
    });
    return true;
  }

  try {
    await member.timeout(null, `moderation action reverted by ${interaction.user?.tag || interaction.user?.id || "staff"}`);
  } catch (err) {
    await replyToModerationLogInteraction(interaction, {
      header: "Could Not Revert",
      body: `Discord refused the timeout clear: ${err?.message || err}`,
      color: DANGER
    });
    return true;
  }

  const target = await resolveActionUser(interaction, action, member);
  const dmSent = await safeSend(target, buildRevertUserPayload({
    action,
    actor: interaction.user
  }));

  await deleteModerationAction(action.id);
  await disableModerationLogButtons(interaction, action.id);
  await sendLog(interaction.guild, buildRevertLogPanel({
    action,
    actor: interaction.user,
    dmSent
  })).catch(() => null);

  await replyToModerationLogInteraction(interaction, {
    header: "Action Reverted",
    body: [
      `timeout cleared for ${action.userId ? `<@${action.userId}>` : action.username || "that user"}`,
      `**User DM:** ${dmSent ? "sent" : "not sent"}`,
      "**SQLite:** review record deleted"
    ].join("\n"),
    color: SUCCESS
  });
  return true;
}

async function maybeHandleModerationLogInteraction(interaction, deps = {}) {
  if (!interaction?.isButton?.()) return false;
  const parsed = parseModerationLogInteraction(interaction.customId);
  if (!parsed?.actionId) return false;

  if (!interaction.inGuild?.()) {
    await replyToModerationLogInteraction(interaction, {
      header: "Server Only",
      body: "these moderation log tools only work inside the Kicia server log channel",
      color: WARN
    });
    return true;
  }

  if (!canUseModerationLogTools(interaction)) {
    await replyToModerationLogInteraction(interaction, {
      header: "Staff Tools Locked",
      body: "only staff and above can use log review controls",
      color: WARN
    });
    return true;
  }

  if (parsed.type === "view") {
    return handleModerationLogView(interaction, parsed.actionId, deps);
  }
  if (parsed.type === "revert") {
    return handleModerationLogRevert(interaction, parsed.actionId, deps);
  }
  return false;
}

function resetModerationState() {
  raidBuckets.clear();
  lastRaidAlertAt.clear();
  recentUserMessages.clear();
  suspiciousUserBuckets.clear();
  sellingUserBuckets.clear();
}

module.exports = {
  detectSellingSignal,
  getScamTradeTextFeatures,
  detectContextualSellingSignal,
  detectProhibitedCommerceSignal,
  detectScamTradeCandidateContext,
  detectSuspiciousSignal,
  detectRoastingSignal,
  detectFakeInfoSignal,
  detectBlockedLinkSignal,
  collectContentSignals,
  getSellingConfidenceTimeoutMs,
  getSellingConfidenceTimeoutTier,
  hasBypassPermission,
  maybeHandleModerationLogInteraction,
  observeRaidMessage,
  resetModerationState,
  maybeHandleModerationWatch,
  buildSellingDmPayload,
  buildSuspiciousDmPayload,
  buildSellingLogPanel,
  buildSuspiciousLogPanel
};
