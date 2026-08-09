/**
 * A seed list of common English lemmas, roughly in order of how early a learner
 * meets them. It exists so book coverage means something on day one — without
 * it a new reader is told they know 0% of a book they can mostly read.
 *
 * The order is approximate, not a frequency ranking: it is used only to slice
 * the list ("mark the first 500 as known"), so what matters is that the easy
 * words come before the harder ones. Everything here is already a base form —
 * the lemmatiser maps inflections onto these.
 */

const TIER_1 = `
the be a to of and in that have i it for not on with he as you do at this but his
by from they we say her she or an will my one all would there their what so up out
if about who get which go me when make can like time no just him know take people
into year your good some could them see other than then now look only come its over
think also back after use two how our work first well way even new want because any
these give day most us
`;

const TIER_2 = `
man thing woman life child world school state family student group country problem
hand part place case week company system program question work government number
night point home water room mother area money story fact month lot right study book
eye job word business issue side kind head house service friend father power hour
game line end member law car city community name president team minute idea kid body
information nothing ago lead social understand whether watch together follow around
parent stop face anything create public already speak others read level allow add
office spend door health person art war history party result change morning reason
research girl guy moment air teacher force education
`;

const TIER_3 = `
foot boy age policy process music market sense nation plan college interest death
experience effect use class control care field development role effort rule area
report society mind law thought heart sound movie table hair sea night type kitchen
window street garden building floor wall glass paper card page picture film camera
phone computer letter list note song voice color light dark red blue green black
white long short big small little large great high low old young new early late slow
fast hot cold warm cool dry wet clean dirty full empty open close hard soft heavy
strong weak rich poor cheap free busy quiet loud safe kind mean nice bad worse
happy sad angry tired hungry thirsty sick well sure ready sorry afraid glad proud
`;

const TIER_4 = `
run walk sit stand sleep wake eat drink cook wash clean buy sell pay cost save
spend send receive bring carry hold catch throw push pull open shut break fix build
grow plant cut wear dress wait meet leave arrive enter return travel drive ride fly
swim climb fall jump dance sing play win lose fight kill die live love hate laugh
cry smile hope wish believe remember forget learn teach explain answer ask tell
speak talk listen hear watch notice seem appear happen become begin start continue
finish stop keep change turn move carry choose decide agree refuse accept offer
suggest promise thank apologize help serve visit invite marry born
`;

const TIER_5 = `
under above below between among against toward through across along beside behind
before during since until while although though because unless however therefore
perhaps maybe almost always never often sometimes usually rarely again once twice
finally suddenly quickly slowly quietly carefully really quite rather enough very
too much many few several each every both either neither none another such same
different similar certain sure possible impossible necessary important useful
strange simple difficult easy true false real whole half part piece bit lot number
amount size shape weight length distance speed price value quality reason cause
answer problem question idea plan way method rule order example
`;

const TIER_6 = `
morning afternoon evening night today tomorrow yesterday week month year hour minute
second moment season spring summer autumn winter monday sunday january december
north south east west left right front back top bottom middle centre corner side
edge end beginning north village town country city farm forest river lake mountain
hill valley field road path bridge station airport hotel shop market restaurant
church hospital library museum park beach island ground sky sun moon star cloud rain
snow wind storm fire ice stone sand grass tree flower leaf fruit bread meat fish
egg milk tea coffee sugar salt dinner lunch breakfast meal
`;

const TIER_7 = `
animal bird dog cat horse cow sheep pig mouse lion tiger bear wolf fox rabbit snake
insect bee fly ant spider clothes shirt coat hat shoe sock dress skirt trouser
pocket button king queen prince soldier captain doctor nurse lawyer farmer worker
servant master guest stranger neighbour crowd village people gentleman lady sir
madam husband wife son daughter brother sister uncle aunt cousin baby marriage
funeral church god heaven hell soul spirit dream memory secret truth lie promise
duty honour shame pride fear anger joy sorrow pain pleasure comfort danger courage
silence noise smell taste touch
`;

export const CORE_WORDS: string[] = [
  TIER_1,
  TIER_2,
  TIER_3,
  TIER_4,
  TIER_5,
  TIER_6,
  TIER_7,
]
  .join(" ")
  .split(/\s+/)
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean)
  .filter((w, i, all) => all.indexOf(w) === i);

/** The presets offered on the coverage screen. */
export const CORE_PRESETS = [100, 300, 600, CORE_WORDS.length] as const;
