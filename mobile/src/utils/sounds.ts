// sounds.ts
import { createAudioPlayer, AudioPlayer } from 'expo-audio';

type SoundName = 'camera_shutter'; // extend as needed

const players = new Map<SoundName, AudioPlayer>();

const sources: Record<SoundName, number> = {
  camera_shutter: require('../../assets/sfx/camera_shutter.mp3'),
};

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  for (const [name, source] of Object.entries(sources)) {
    players.set(name as SoundName, createAudioPlayer(source));
  }
  initialized = true;
}

export function playSfx(name: SoundName, volume = 1) {
  ensureInitialized();

  const player = players.get(name);
  if (!player) return;

  player.volume = volume;
  player.seekTo(0);
  player.play();
}

export function unloadSounds() {
  for (const player of players.values()) {
    player.release();
  }
  players.clear();
  initialized = false;
}