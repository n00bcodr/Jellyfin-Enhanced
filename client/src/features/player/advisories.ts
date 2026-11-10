  // Advisory tag patterns, most serious first
  const ADVISORY_PATTERNS = [
    /gore|gory|torture|mutilat|dismember|decapitat|cannibal|massacre|genocide|war crime|brutal|serial killer|mass murder|mass shooting|school shooting|snuff|sadis/i,
    /\brape\b|\braped\b|sexual (assault|abuse|violence)|molest|incest|child abuse|domestic (violence|abuse)|human trafficking|sex trafficking|pedophil|paedophil/i,
    /violen|murder|killing|kill(er|ings)|assault|stabbing|shootout|gunfight|shooting|beating|blood|bloody|execution|hostage|kidnap|abduct|terroris|bombing|hitman|assassin|revenge|vigilante|hand.to.hand|martial arts|fistfight|bar fight|brawl|\bfight/i,
    /\bsex\b|sex scene|sexual (content|situation|reference|theme)|nudity|\bnude\b|erotic|softcore|orgy|prostitut|brothel|striptease|stripper|pornograph|lingerie|seduction|adultery|infidelity|innuendo/i,
    /\bdrug|cocaine|heroin|methamphetamine|\bmeth\b|cannabis|marijuana|opioid|overdose|addict|alcohol|drunk|drinking|smoking|tobacco|cigarette|gambl|cartel|dealer/i,
    /(strong|coarse|bad|explicit|foul|crude) language|profan|swear|vulgar|obscen|f.word|slur|expletive|crude humou?r|toilet humou?r|rude humou?r/i,
    /horror|slasher|disturbing|frightening|terrifying|terror|body horror|psychological horror|gruesome|macabre|nightmare|jump scare|possession|exorcis|demon|satan|occult|haunted|creepy|ghost|zombie|undead|monster|vampire/i,
    /suicide|self.?harm|eating disorder|mental (illness|health)|depression|trauma|ptsd|abuse|neglect|racis|sexis|homophob|transphob|antisemit|nazi|holocaust|slavery|discriminat|hate crime|bigot|segregation/i,
    /peril|threat|scary|scare|spooky|intense|tension|suspense|chase|danger|survival|disaster|natural disaster|shipwreck|plane crash|car crash|explosion/i,
    /infiltrat|rogue agent|double agent|secret agent|undercover|espionage|\bspy\b|spies|conspiracy|sabotage|hijack|manhunt|cover.?up|betray|blackmail|assassination plot|coup|whistleblower/i,
    /\bdeath|dying|grief|bereave|funeral|terminal illness|cancer|illness|disease|injur|disabilit|hospital|orphan|bullying|loss of/i,
    /(mild|cartoon|fantasy|slapstick|comic|action) violence|slapstick|weapon|\bgun|sword|knife|war\b|military|soldier|battle|flashing|strobe|photosensitiv/i,
    /crime|gangster|mafia|mob boss|organized crime|heist|robbery|burglar|corrupt|prison|fraud|smuggl|underworld/i
  ];

  export function pickAdvisories(tags: string[]) {
    const ranked = [];
    for (const tag of tags) {
      const rank = ADVISORY_PATTERNS.findIndex(re => re.test(tag));
      if (rank !== -1) ranked.push({ tag, rank });
    }
    ranked.sort((x, y) => x.rank - y.rank);
    const names = ranked.map(r => r.tag);
    // Drop tags contained in another ("murder" in "mass murder")
    return names
      .filter(n => !names.some(o => o !== n && o.toLowerCase().includes(n.toLowerCase())))
      .map(n => n.replace(/(^|\s)(\S)/g, (_: string, sp: string, ch: string) => sp + ch.toUpperCase()));
  }

