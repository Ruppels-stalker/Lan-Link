const ADJECTIVES = ['Golden', 'Swift', 'Silent', 'Brave', 'Clever', 'Mighty', 'Sleepy', 'Cosmic', 'Electric', 'Neon'];
const NOUNS = ['Potato', 'Squirrel', 'Falcon', 'Panther', 'Wizard', 'Ninja', 'Panda', 'Tiger', 'Robot', 'Dragon'];

export function generateFunnyName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}
