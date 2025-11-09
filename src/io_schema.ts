
// Here are some properties which are shared by different types

// TOPOgraphy is the shape of the land itself (applies to both height or voxel)
export type Topography = "canyon" | "cliffs" | "dunes" | "wetlands" | "hilly" | "craggy" | "flat"  | "gullies" | "crater" | "moorlands" | "islets" | "valley";

// BIOME determines the foliage, humidity, and other environmental factors
export type Biome = "saltmarsh" | "wetlands" | "rocky" | "tundra" | "forest" | "meadow" | "coastal scrub" | "woodland" | "desert" | "beach";

// WEATHER includes rain, fog, snow, and also atmospheric conditions like dust and sand storms
export type Weather = "clear" | "cloudy" | "foggy" | "overcast" | "partly cloudy" | "rain" | "light rain" | "thunderstorm" | "dusty" | "sand storm" | "snow" | "light snow" | "blizzard";

// TIMEOFDAY is the time of day in the area
export type TimeOfDay = "Predawn" | "Daybreak" | "Morning" | "Midday" | "Afternoon" | "Sunset" | "Evening" | "Night" | "Midnight";

// MOOD is a catch-all "vibe" parameter for music, vfx, etc.
export type Mood = "Violent" | "Peaceful" | "Joyous" | "Dismal" | "Intrigue" | "Excitement";

// MATERIAL is mandmade construction type for buildings, bridges, etc.
export type Material = "wooden" | "stone" | "metal" | "glass" | "concrete" | "brick" |  "reolyte";


export type Island = {
    // the name of the island, unique within the game
    // should be descriptive and evocative
    island_name: string;

     // the narrative gameplay goal of the island. one sentence.
    goal: string;
     
    // the story context of the island, why it's significant,
    // what niala might hope to find, etc. two sentences.
    story_context: string;


    // topography outside and between regions
    base_topography: Topography;
    // biome outside and between regions
    base_biome: Biome;
    // weather outside and between regions
    base_weather: Weather;

    population: number;         // experimental
    
    // all the different ways you can enter the island
    // beachhead, dirigible, ferry, bridge, tunnel, dock, etc.
    starting_routes: Route[];    // routes are like html links: typed unidirectional embedded objects

    // all the regions on the island
    regions: Region[];
}

export type Region = {
    region_name: string;                // a unique human-readable name for the region, giving a flavor or the region's purpose
    story: string;                      // the story meaning of this region, why it's significant
    region_number: number;

    topography: Topography;
    biome: Biome;
    weather: Weather;
    time: TimeOfDay;

    size: "small" | "medium" | "large" | "extra large";

    buildings: Building[];
    fauna?: Fauna[];
    artifacts?: Artifact[];

    next_area: Route;           // the next area the player can go to
    shortcut?: Route;           // optional shortcut to another area
    other_routes?: Route[];     // even more optional other routes

    altitude: number;           // the altitude of the region, in meters
    location_x: number;         // the x coordinate of the region, in meters 
    location_y: number;         // the y coordinate of the region, in meters
}

export type Route = {
    route_type: "road" | "path" | "trail" | "bridge" | "tunnel" | "ferry" | "beachhead" | "dirigible" | "dock";
    difficulty: "easy" | "medium" | "hard" | "impossible";
    open: boolean;

    topography: Topography;       // the topography traversed by the route; mountainous implies canyon, etc.
    biome: Biome;             // the biome traversed by the route; bridge implies river, etc.
    weather: Weather;         // the weather encountered on the route

    destination_name: string; // the name of region the route leads to
    direction?: "north" | "south" | "east" | "west" | "up" | "down";
}

// BUILDING
export type Building = {
    building_name: string;

    building_type: "house" | "manor" | "church" | "hut" | "tower" | "castle" | "dockhouse" | "lighthouse" | "fortress" | "monastery";

    gameplay_purpose: string;       // what is this building for?
    adjectives: string[]; // what is this building like?
    story: string;        // what is the story of this building? why is it here?
    inhabitants: Fauna[]; // who lives here?
    artifacts: Artifact[]; // what's inside?
    
    material: Material;
    size: "small" | "medium" | "large" | "extra large";
}

export type GeoFeature = {
    feature_name: string;
    background: string;
    feature_type: "hill" | "mountain" | "valley" | "lake" | "plateau" | "canyon" | "river" | "waterfall" | "marsh";

    size: "small" | "medium" | "large" | "extra large";
   
    buildings?: Building[];
    fauna?: Fauna[];
    artifacts?: Artifact[];
}


///////////
//
// ARTIFACTS
// Artifacts are objects that can be picked up and carried by the player
// Weapons, artifacts, etc.
export type Artifact = {
    name: string;
    artifact_type: "weapon" | "treasure" | "pottery" | "weaving" | "tailoring" | "leatherworking" | "armor" | "jewelry" | "gemstone" | "glass" | "ceramic" | "paper" | "ink" | "book" | "scroll" | "map" | "painting" | "sculpture" | "statue" | "furniture" | "carpet" | "tapestry" | "curtain" | "cushion" | "bed";

    significance: "important" | "minor" | "hidden";
    value: number;
};


///////////
//
// BEINGS
// Beings are living entities that can be interacted with
// Humans, animals, and monsters
//
///////////

// BEING interface
export interface Being {
    demeanor: "Friendly" | "Neutral" | "Hostile";
    demeanor_strength: number;
    alive: boolean;
    strength: "weak" | "average" | "strong" | "boss";
    intelligence: "low" | "average" | "high" | "demigod";
    diet: "herbivore" | "carnivore" | "omnivore";
}

// HUMAN interface
export interface Human extends Being {
    human_name: string;             // the name of the human, unique within the game
    current_activity: string;
    intended_goal: string;
    character_class: "paladin" | "seer" | "farmer" | "mechanic" | "plommer" | "hunter" | "seaman" | "herbalist" | "bard" | "mage" | "warrior" | "rogue" | "druid" | "nekran" | "envoy";
    backstory: string;
}

// MONSTER interface
export interface Monster extends Being {
    species: "wirulf" | "Decimator" | "Ecomental" | "goblin" | "orc" | "troll" | "dragon" | "wyvern" | "giant" | "beast" | "undead" | "elemental" | "demon" | "angel" | "monster" | "creature" | "boss";
 }

// ANIMAL interface
export interface Animal extends Being {
    species: "wolf" | "crow" | "deer" | "rabbit" | "fox" | "bear" | "owl" | "eagle" | "hawk" | "sparrow" | "seagull" | "pigeon" | "panther" | "lynx";
}

export interface SeaAnimal extends Being {
    species: "whale" | "dolphin" | "seal" | "squid" | "octopus" | "jellyfish" | "starfish" | "crab" | "lobster" | "eel";
}

export type Fauna = Being | Human | Monster | Animal | SeaAnimal;
