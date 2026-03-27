const { SlashCommandBuilder } = require('discord.js');

module.exports = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube, Spotify, or a search query.')
    .addStringOption((option) =>
      option
        .setName('song')
        .setDescription('A song name, YouTube link, or Spotify link.')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your current voice channel.'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel and clear the queue.'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track.'),

  new SlashCommandBuilder()
    .setName('next')
    .setDescription('Skip to the next track in the queue.'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue.'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current track.'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused track.'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue.'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Refresh the now playing panel.'),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Change the playback volume.')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Volume level from 1 to 200.')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(200)
    ),

  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Change the loop mode.')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Choose how the queue should loop.')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' }
        )
    ),

  new SlashCommandBuilder()
    .setName('247')
    .setDescription('Toggle 24/7 mode to keep the bot connected when the queue is idle.')
    .addBooleanOption((option) =>
      option
        .setName('enabled')
        .setDescription('Turn 24/7 mode on or off.')
        .setRequired(true)
    )
];
