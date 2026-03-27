require('dotenv').config();

const http = require('node:http');
const { PassThrough, Readable } = require('node:stream');

const {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits
} = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} = require('@discordjs/voice');
const play = require('play-dl');
const spotifyUrlInfo = require('spotify-url-info')(globalThis.fetch);
const ytdl = require('@distube/ytdl-core');
const youtubeDl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const {
  COLORS,
  createAddedToQueueEmbed,
  createInfoEmbed,
  createNowPlayingEmbed,
  createPlaybackControls,
  createPlaybackFailureEmbed,
  createQueueEmbed,
  createUpNextEmbed
} = require('./ui');

if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

if (!process.env.TOKEN) {
  throw new Error('Missing TOKEN in .env');
}

const hasSpotifyApiCredentials = Boolean(
  process.env.SPOTIFY_CLIENT_ID &&
    process.env.SPOTIFY_CLIENT_SECRET &&
    process.env.SPOTIFY_REFRESH_TOKEN
);
const playTokenConfig = {};

if (process.env.YOUTUBE_COOKIE) {
  playTokenConfig.youtube = {
    cookie: process.env.YOUTUBE_COOKIE
  };
}

if (hasSpotifyApiCredentials) {
  playTokenConfig.spotify = {
    client_id: process.env.SPOTIFY_CLIENT_ID,
    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
    refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
    market: process.env.SPOTIFY_MARKET || 'US'
  };
}

if (Object.keys(playTokenConfig).length > 0) {
  play.setToken(playTokenConfig).catch((error) => {
    console.error('Failed to load play-dl tokens:', error);
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const queues = new Map();
const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const IDLE_DISCONNECT_MS = 2 * 60 * 1000;
const SPOTIFY_COLLECTION_LIMIT = 25;
const VOICE_CONNECT_TIMEOUT_MS = 30_000;
const VOICE_REJOIN_TIMEOUT_MS = 20_000;
const YTDL_PLAYER_CLIENTS = ['ANDROID', 'IOS', 'TV', 'WEB', 'WEB_EMBEDDED'];
const ytdlAgent = createYtdlAgent(process.env.YOUTUBE_COOKIE);
let youtubeClientPromise = null;
let isShuttingDown = false;
const healthServer = createHealthServer();

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserFacingError';
  }
}

client.once('clientReady', () => {
  console.log(`Ready as ${client.user.tag}`);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('shardError', (error) => {
  console.error('Discord shard error:', error);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    await handlePlaybackControlInteraction(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    switch (interaction.commandName) {
      case 'play':
        await handlePlayCommand(interaction);
        break;
      case 'join':
        await handleJoinCommand(interaction);
        break;
      case 'leave':
        await handleLeaveCommand(interaction);
        break;
      case 'skip':
      case 'next':
        await handleSkipCommand(interaction);
        break;
      case 'stop':
        await handleStopCommand(interaction);
        break;
      case 'pause':
        await handlePauseCommand(interaction);
        break;
      case 'resume':
        await handleResumeCommand(interaction);
        break;
      case 'queue':
        await handleQueueCommand(interaction);
        break;
      case 'nowplaying':
        await handleNowPlayingCommand(interaction);
        break;
      case 'volume':
        await handleVolumeCommand(interaction);
        break;
      case 'loop':
        await handleLoopCommand(interaction);
        break;
      case '247':
        await handleTwentyFourSevenCommand(interaction);
        break;
      default:
        throw new UserFacingError('That command is not recognized.');
    }
  } catch (error) {
    console.error(`Command failed (${interaction.commandName}):`, error);
    await replyError(interaction, formatMusicError(error));
  }
});

async function handlePlaybackControlInteraction(interaction) {
  if (!interaction.customId.startsWith('music:')) {
    return;
  }

  try {
    await interaction.deferUpdate();

    switch (interaction.customId) {
      case 'music:pause-toggle':
        await handlePauseToggleButton(interaction);
        break;
      case 'music:next':
        await handleNextButton(interaction);
        break;
      case 'music:stop':
        await handleStopButton(interaction);
        break;
      case 'music:queue':
        await handleQueueButton(interaction);
        break;
      default:
        break;
    }
  } catch (error) {
    if (
      error instanceof UserFacingError &&
      (
        error.message === 'No track is currently playing.' ||
        error.message === 'There is no active music session right now.'
      )
    ) {
      await interaction.message?.edit({ components: [] }).catch(() => null);
      return;
    }

    console.error(`Playback control failed (${interaction.customId}):`, error);
    await replyButtonError(interaction, formatMusicError(error));
  }
}

async function handlePauseToggleButton(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  const transitionSong = getTransitionSong(queue);

  if (transitionSong) {
    queue.pauseOnStart = !queue.pauseOnStart;
    await previewUpcomingSongPanel(queue, transitionSong, interaction.message);

    return;
  }

  if (!queue.currentSong) {
    await interaction.message?.edit({ components: [] }).catch(() => null);
    return;
  }

  const wasPaused = isQueuePaused(queue);
  if (wasPaused) {
    const resumed = queue.player.unpause();
    if (!resumed) {
      throw new UserFacingError('There is no paused track to resume right now.');
    }
    markCurrentSongResumed(queue);
  } else {
    const paused = queue.player.pause();
    if (!paused) {
      throw new UserFacingError('Playback is already paused.');
    }
    markCurrentSongPaused(queue);
  }

  await syncNowPlayingPanel(queue, interaction.message);
}

async function handleNextButton(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  if (!hasTrackContext(queue)) {
    return;
  }

  await skipToNextTrack(queue, interaction.message);
}

async function handleStopButton(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  const stayedConnected = await stopQueuePlayback(queue, interaction.message);

  if (stayedConnected) {
    await interaction.followUp({
      embeds: [
        createInfoEmbed(
          'Playback Stopped',
          'The queue was cleared, and I stayed in the voice channel because 24/7 mode is enabled.',
          COLORS.primary
        )
      ],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }
}

async function handleQueueButton(interaction) {
  const queue = getExistingQueue(interaction.guildId);

  await interaction.followUp({
    embeds: [createQueueEmbed(queue)],
    flags: MessageFlags.Ephemeral
  });
}

async function handlePlayCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const voiceChannel = getRequiredMemberVoiceChannel(interaction);
  validateVoicePermissions(interaction, voiceChannel);

  const existingQueue = queues.get(interaction.guildId);
  if (existingQueue && existingQueue.voiceChannelId !== voiceChannel.id) {
    throw new UserFacingError(
      'The bot is already active in another voice channel in this server. Join that channel or stop playback first.'
    );
  }

  const query = interaction.options.getString('song', true).trim();
  const resolved = await resolveTracks(query, interaction.member);

  if (resolved.tracks.length === 0) {
    throw new UserFacingError('I could not find any playable result for that request.');
  }

  const queue = existingQueue || (await createQueue(interaction.guild, voiceChannel));

  queue.textChannelId = interaction.channelId;
  queue.songs.push(...resolved.tracks);

  if (queue.isPlaying && queue.currentSong) {
    await syncNowPlayingPanel(queue);
  }

  await interaction.editReply({
    embeds: [createAddedToQueueEmbed(resolved, queue, voiceChannel)]
  });

  if (!queue.isPlaying) {
    await playNext(interaction.guildId);
  }
}

async function handleJoinCommand(interaction) {
  const voiceChannel = getRequiredMemberVoiceChannel(interaction);
  validateVoicePermissions(interaction, voiceChannel);

  const existingQueue = queues.get(interaction.guildId);
  if (existingQueue) {
    if (existingQueue.voiceChannelId === voiceChannel.id) {
      await interaction.reply({
        embeds: [
          createInfoEmbed(
            'Already Connected',
            `I am already connected to **${voiceChannel.name}** and ready to play music.`,
            COLORS.primary
          )
        ]
      });
      return;
    }

    throw new UserFacingError(
      'The bot is already connected to another voice channel. Use `/leave` or `/stop` first, then try again.'
    );
  }

  await createQueue(interaction.guild, voiceChannel);

  await interaction.reply({
    embeds: [
      createInfoEmbed(
        'Joined Voice Channel',
        `I joined **${voiceChannel.name}**. Use \`/play\` to start music.`,
        COLORS.success
      )
    ]
  });
}

async function handleLeaveCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  await disableNowPlayingPanel(queue);
  destroyQueue(interaction.guildId);

  await interaction.reply({
    embeds: [
      createInfoEmbed(
        'Disconnected',
        'I left the voice channel and cleared the queue.',
        COLORS.warning
      )
    ]
  });
}

async function handleSkipCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  const result = await skipToNextTrack(queue);

  await interaction.reply({
    embeds: [
      createInfoEmbed(
        'Track Skipped',
        result.alreadySwitching
          ? 'The player is already loading the next track.'
          : result.hasUpcoming
            ? 'Skipping to the next track now.'
            : 'Skipped the current track. The queue is now empty.',
        COLORS.success
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

async function handleStopCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  const stayedConnected = await stopQueuePlayback(queue);

  await interaction.reply({
    embeds: [
      createInfoEmbed(
        'Playback Stopped',
        stayedConnected
          ? 'Playback has been stopped and the queue has been cleared. 24/7 mode kept me connected to the voice channel.'
          : 'Playback has been stopped and the queue has been cleared.',
        stayedConnected ? COLORS.primary : COLORS.warning
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

async function handlePauseCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);
  const transitionSong = getTransitionSong(queue);

  if (transitionSong) {
    queue.pauseOnStart = true;
    await previewUpcomingSongPanel(queue, transitionSong);

    await interaction.reply({
      embeds: [
        createInfoEmbed(
          'Pause Scheduled',
          'The next track will start in a paused state.',
          COLORS.primary
        )
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!queue.currentSong) {
    throw new UserFacingError('No track is currently playing.');
  }

  const paused = queue.player.pause();
  if (!paused) {
    throw new UserFacingError('Playback is already paused.');
  }
  markCurrentSongPaused(queue);

  await interaction.reply({
    embeds: [
      createInfoEmbed('Playback Paused', 'The current track has been paused.', COLORS.primary)
    ],
    flags: MessageFlags.Ephemeral
  });

  await syncNowPlayingPanel(queue);
}

async function handleResumeCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);
  const transitionSong = getTransitionSong(queue);

  if (transitionSong) {
    queue.pauseOnStart = false;
    await previewUpcomingSongPanel(queue, transitionSong);

    await interaction.reply({
      embeds: [
        createInfoEmbed(
          'Resume Scheduled',
          'The next track will continue normally.',
          COLORS.success
        )
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!queue.currentSong) {
    throw new UserFacingError('No track is currently playing.');
  }

  const resumed = queue.player.unpause();
  if (!resumed) {
    throw new UserFacingError('There is no paused track to resume right now.');
  }
  markCurrentSongResumed(queue);

  await interaction.reply({
    embeds: [
      createInfoEmbed('Playback Resumed', 'The current track has resumed.', COLORS.success)
    ],
    flags: MessageFlags.Ephemeral
  });

  await syncNowPlayingPanel(queue);
}

async function handleQueueCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);

  if (!queue.currentSong && !queue.pendingSong && queue.songs.length === 0) {
    throw new UserFacingError('The queue is currently empty.');
  }

  await interaction.reply({
    embeds: [createQueueEmbed(queue)],
    flags: MessageFlags.Ephemeral
  });
}

async function handleNowPlayingCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  const transitionSong = getTransitionSong(queue);

  if (transitionSong) {
    await previewUpcomingSongPanel(queue, transitionSong);
  } else {
    if (!queue.currentSong) {
      throw new UserFacingError('No track is currently playing.');
    }

    await syncNowPlayingPanel(queue);
  }

  await interaction.reply({
    embeds: [
      createInfoEmbed('Player Panel Refreshed', 'The player panel has been refreshed in this channel.', COLORS.success)
    ],
    flags: MessageFlags.Ephemeral
  });
}

async function handleVolumeCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  const level = interaction.options.getInteger('level', true);
  queue.volume = level;

  const resource = queue.player.state.resource;
  if (resource?.volume) {
    resource.volume.setVolume(level / 100);
    await interaction.reply({
      embeds: [
        createInfoEmbed('Volume Updated', `The volume is now set to **${level}%**.`, COLORS.success)
      ],
      flags: MessageFlags.Ephemeral
    });
    await syncNowPlayingPanel(queue);
    return;
  }

  await interaction.reply({
    embeds: [
      createInfoEmbed('Volume Updated', `The volume is now set to **${level}%**.`, COLORS.success)
    ],
    flags: MessageFlags.Ephemeral
  });
  await syncNowPlayingPanel(queue);
}

async function handleLoopCommand(interaction) {
  const queue = getExistingQueue(interaction.guildId);
  ensureSameVoiceChannel(interaction, queue);

  const mode = interaction.options.getString('mode', true);
  queue.loopMode = mode;

  await interaction.reply({
    embeds: [
      createInfoEmbed('Loop Mode Updated', `The loop mode is now **${formatLoopMode(mode)}**.`, COLORS.primary)
    ],
    flags: MessageFlags.Ephemeral
  });
  await syncNowPlayingPanel(queue);
}

async function handleTwentyFourSevenCommand(interaction) {
  const enabled = interaction.options.getBoolean('enabled', true);
  const existingQueue = queues.get(interaction.guildId);

  if (!existingQueue && !enabled) {
    await interaction.reply({
      embeds: [
        createInfoEmbed(
          '24/7 Mode Updated',
          '24/7 mode is already disabled. Start a session first if you want me to join a voice channel.',
          COLORS.warning
        )
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const voiceChannel = getRequiredMemberVoiceChannel(interaction);
  validateVoicePermissions(interaction, voiceChannel);

  if (existingQueue) {
    ensureSameVoiceChannel(interaction, existingQueue);
  }

  const queue = existingQueue || (await createQueue(interaction.guild, voiceChannel));
  queue.textChannelId = interaction.channelId;
  queue.stayConnected = enabled;

  if (enabled) {
    clearIdleDisconnect(queue);
  } else if (isQueueIdle(queue)) {
    scheduleIdleDisconnect(interaction.guildId);
  }

  await interaction.reply({
    embeds: [
      createInfoEmbed(
        '24/7 Mode Updated',
        enabled
          ? `24/7 mode is now **enabled**. I will stay connected in **${voiceChannel.name}** when the queue is idle.`
          : '24/7 mode is now **disabled**. If nothing is playing, I will disconnect after two minutes of inactivity.',
        enabled ? COLORS.success : COLORS.warning
      )
    ],
    flags: MessageFlags.Ephemeral
  });

  const transitionSong = getTransitionSong(queue);
  if (transitionSong) {
    await previewUpcomingSongPanel(queue, transitionSong);
    return;
  }

  if (queue.currentSong) {
    await syncNowPlayingPanel(queue);
  }
}

async function skipToNextTrack(queue, preferredMessage = null) {
  if (queue.pendingSong) {
    if (queue.songs.length > 0) {
      queue.songs.shift();
    }

    const upcomingSong = queue.songs[0] || null;
    queue.pendingSong = upcomingSong ? stripRuntimeFields(upcomingSong) : null;

    if (upcomingSong) {
      await previewUpcomingSongPanel(queue, upcomingSong, preferredMessage);
    }

    return {
      alreadySwitching: false,
      hasUpcoming: Boolean(upcomingSong),
      skippedDuringTransition: true
    };
  }

  if (queue.isPreparing && queue.currentSong) {
    queue.playbackNonce += 1;

    const upcomingSong = queue.songs[0] || null;
    queue.currentSong = null;
    queue.isPlaying = false;
    queue.isPreparing = false;
    queue.pendingSong = upcomingSong ? stripRuntimeFields(upcomingSong) : null;

    if (upcomingSong) {
      await previewUpcomingSongPanel(queue, upcomingSong, preferredMessage);
      await playNext(queue.guildId);
    } else {
      await disableNowPlayingPanel(queue, preferredMessage);
      scheduleIdleDisconnect(queue.guildId);
    }

    return {
      alreadySwitching: false,
      hasUpcoming: Boolean(upcomingSong),
      skippedDuringTransition: true
    };
  }

  if (!queue.currentSong) {
    const transitionSong = getTransitionSong(queue);
    if (transitionSong) {
      await previewUpcomingSongPanel(queue, transitionSong, preferredMessage);
      return {
        alreadySwitching: true,
        hasUpcoming: Boolean(queue.songs[0]),
        skippedDuringTransition: true
      };
    }

    throw new UserFacingError('No track is currently playing.');
  }

  const upcomingSong = queue.songs[0] || null;
  queue.pendingSong = upcomingSong ? stripRuntimeFields(upcomingSong) : null;

  if (upcomingSong) {
    await previewUpcomingSongPanel(queue, upcomingSong, preferredMessage);
  }

  queue.skipRequested = true;
  queue.player.stop(true);

  return {
    alreadySwitching: false,
    hasUpcoming: Boolean(upcomingSong)
  };
}

async function previewUpcomingSongPanel(
  queue,
  song = getTransitionSong(queue),
  preferredMessage = null
) {
  if (!song) {
    return null;
  }

  return enqueuePanelUpdate(queue, async () => {
    const channel = await getQueueTextChannel(queue);
    if (!channel) {
      return null;
    }

    const payload = {
      embeds: [createUpNextEmbed(song, queue)],
      components: [createPlaybackControls(queue)]
    };

    const { targetMessage } = await resolvePanelTarget(queue, channel, preferredMessage);

    if (targetMessage && targetMessage.editable) {
      const updatedMessage = await targetMessage.edit(payload).catch(() => null);
      if (updatedMessage) {
        queue.panelMessageId = updatedMessage.id;
        return updatedMessage;
      }
    }

    const sentMessage = await channel.send(payload).catch(() => null);
    if (sentMessage) {
      queue.panelMessageId = sentMessage.id;
    }

    return sentMessage;
  });
}

async function createQueue(guild, voiceChannel) {
  const staleConnection = getVoiceConnection(guild.id);
  if (staleConnection) {
    try {
      staleConnection.destroy();
    } catch {
      // Ignore stale connection cleanup errors before reconnecting.
    }
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  const connectionStateTrace = [];
  const trackConnectionState = (_oldState, newState) => {
    const traceEntry = `${new Date().toISOString()} ${newState.status}`;
    connectionStateTrace.push(traceEntry);
    if (connectionStateTrace.length > 8) {
      connectionStateTrace.shift();
    }
  };

  connection.on('stateChange', trackConnectionState);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);
  } catch (error) {
    const firstFailureState = connection.state.status;
    console.error(
      `Voice connection did not become ready on first attempt in guild ${guild.id}:`,
      {
        channelId: voiceChannel.id,
        state: firstFailureState,
        error: error?.message || error
      }
    );

    try {
      connection.rejoin();
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_REJOIN_TIMEOUT_MS);
    } catch (retryError) {
      const failedState = connection.state.status;
      const stateTrace = connectionStateTrace.join(' -> ');

      console.error(
        `Voice connection failed to become ready after retry in guild ${guild.id}:`,
        {
          channelId: voiceChannel.id,
          state: failedState,
          firstError: error?.message || error,
          retryError: retryError?.message || retryError,
          stateTrace
        }
      );

      try {
        connection.destroy();
      } catch {
        // Ignore cleanup errors if the connection never fully initialized.
      }

      throw new UserFacingError(
        `I could not finish the voice connection inside **${voiceChannel.name}**. Last connection state: \`${failedState}\`.`
      );
    }
  } finally {
    connection.off('stateChange', trackConnectionState);
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  });

  const queue = {
    guildId: guild.id,
    voiceChannelId: voiceChannel.id,
    textChannelId: null,
    connection,
    player,
    songs: [],
    currentSong: null,
    pendingSong: null,
    pauseOnStart: false,
    isPlaying: false,
    isPreparing: false,
    playbackNonce: 0,
    loopMode: 'off',
    stayConnected: false,
    skipRequested: false,
    volume: 70,
    idleTimeout: null,
    isRecovering: false,
    panelMessageId: null,
    panelRefreshTimeout: null,
    panelUpdatePromise: Promise.resolve()
  };

  connection.subscribe(player);

  player.on('stateChange', (_oldState, newState) => {
    const activeQueue = queues.get(guild.id);
    if (!activeQueue?.currentSong) {
      return;
    }

    if (newState.status === AudioPlayerStatus.Paused || newState.status === AudioPlayerStatus.AutoPaused) {
      markCurrentSongPaused(activeQueue);
      scheduleNowPlayingPanelRefresh(activeQueue);
      return;
    }

    if (newState.status === AudioPlayerStatus.Playing) {
      markCurrentSongResumed(activeQueue);
      scheduleNowPlayingPanelRefresh(activeQueue);
      return;
    }

    if (newState.status === AudioPlayerStatus.Buffering) {
      scheduleNowPlayingPanelRefresh(activeQueue);
    }
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    const activeQueue = queues.get(guild.id);
    if (!activeQueue) {
      return;
    }

    if (activeQueue.isRecovering) {
      return;
    }

    const finishedSong = activeQueue.currentSong;
    const skipRequested = activeQueue.skipRequested;

    if (!finishedSong) {
      activeQueue.skipRequested = false;
      activeQueue.isPreparing = false;
      activeQueue.isPlaying = false;
      return;
    }

    if (
      activeQueue.loopMode === 'track' &&
      !skipRequested
    ) {
      activeQueue.songs.unshift(stripRuntimeFields(finishedSong));
    } else if (
      activeQueue.loopMode === 'queue' &&
      !skipRequested
    ) {
      activeQueue.songs.push(stripRuntimeFields(finishedSong));
    }

    activeQueue.skipRequested = false;
    activeQueue.currentSong = null;
    activeQueue.isPreparing = false;
    activeQueue.isPlaying = false;
    await playNext(guild.id);
  });

  player.on('error', async (error) => {
    const activeQueue = queues.get(guild.id);
    if (shouldIgnorePlayerPlaybackError(activeQueue, error, activeQueue?.currentSong)) {
      return;
    }

    console.error(
      `Audio player error in guild ${guild.id}:`,
      error?.message || error
    );
    if (error?.stack) {
      console.error(error.stack);
    }
    if (!activeQueue) {
      return;
    }

    await handlePlaybackFailure(
      guild.id,
      activeQueue.currentSong || { title: 'This track' },
      error,
      {
        stopPlayer: false,
        continueImmediately: true
      }
    );
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      destroyQueue(guild.id);
    }
  });

  queues.set(guild.id, queue);
  return queue;
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) {
    return;
  }

  clearPanelRefresh(queue);
  const nextSong = queue.songs.shift();
  if (!nextSong) {
    queue.currentSong = null;
    queue.pendingSong = null;
    queue.pauseOnStart = false;
    queue.isPlaying = false;
    queue.isPreparing = false;
    await disableNowPlayingPanel(queue);
    scheduleIdleDisconnect(guildId);
    return;
  }

  clearIdleDisconnect(queue);
  const playbackNonce = ++queue.playbackNonce;
  queue.pendingSong = null;
  queue.skipRequested = false;
  const currentSong = {
    ...nextSong,
    sourceLabel: nextSong.sourceLabel || inferTrackSourceLabel(nextSong.url),
    playbackNonce,
    playbackProvider: null,
    startedAt: Date.now(),
    pausedAt: null,
    accumulatedPausedMs: 0
  };
  queue.currentSong = currentSong;
  queue.isPlaying = true;
  queue.isPreparing = true;

  let source = null;
  let preparedSource = null;

  try {
    const streamUrl = nextSong.url || getPlayableUrl(nextSong);
    if (!streamUrl) {
      throw new UserFacingError(
        `I could not build a playable URL for **${nextSong.title}**.`
      );
    }

    source = await createAudioSource(streamUrl);
    if (!isCurrentPlaybackAttempt(queue, playbackNonce, currentSong)) {
      destroyAudioStream(source?.stream);
      return;
    }

    preparedSource = await prepareAudioSource(source);
    if (!isCurrentPlaybackAttempt(queue, playbackNonce, currentSong)) {
      destroyAudioStream(preparedSource?.stream);
      return;
    }

    const audioStream = preparedSource.stream;
    audioStream.once('error', (streamError) => {
      const activeQueue = queues.get(guildId);
      if (shouldIgnoreTrackStreamError(activeQueue, streamError, playbackNonce, currentSong)) {
        return;
      }

      console.error(`YouTube stream error for "${nextSong.title}":`, streamError);
      void handlePlaybackFailure(guildId, nextSong, streamError, {
        stopPlayer: false,
        continueImmediately: true
      });
    });

    const resource = createAudioResource(audioStream, {
      inputType: preparedSource.inputType,
      inlineVolume: preparedSource.inlineVolume,
      metadata: {
        guildId,
        playbackNonce,
        title: nextSong.title
      }
    });

    if (resource.volume) {
      resource.volume.setVolume(queue.volume / 100);
    }

    if (!isCurrentPlaybackAttempt(queue, playbackNonce, currentSong)) {
      destroyAudioStream(audioStream);
      return;
    }

    currentSong.playbackProvider = preparedSource.provider;
    queue.player.play(resource);
    if (queue.pauseOnStart) {
      queue.player.pause();
      markCurrentSongPaused(queue);
      queue.pauseOnStart = false;
    }
    queue.isPreparing = false;
    await syncNowPlayingPanel(queue);
    console.log(
      `Playing in guild ${guildId} via ${preparedSource.provider} (${preparedSource.inputType}): ${nextSong.title}`
    );
  } catch (error) {
    if (!isCurrentPlaybackAttempt(queue, playbackNonce, currentSong)) {
      destroyAudioStream(preparedSource?.stream || source?.stream);
      return;
    }

    queue.isPreparing = false;
    console.error(`Failed to stream "${nextSong.title}":`, error);
    await handlePlaybackFailure(guildId, nextSong, error, {
      stopPlayer: false,
      continueImmediately: true
    });
  }
}

function isCurrentPlaybackAttempt(queue, playbackNonce, currentSong = null) {
  return (
    Boolean(queue) &&
    queue.playbackNonce === playbackNonce &&
    (currentSong ? queue.currentSong === currentSong : true)
  );
}

function getSongElapsedSeconds(song) {
  if (!song?.startedAt) {
    return 0;
  }

  const referenceTime = song.pausedAt || Date.now();
  const accumulatedPausedMs = song.accumulatedPausedMs || 0;
  const elapsedMs = Math.max(0, referenceTime - song.startedAt - accumulatedPausedMs);
  return Math.floor(elapsedMs / 1000);
}

function isNearTrackCompletion(song, thresholdSeconds = 3) {
  if (!song?.durationInSec) {
    return false;
  }

  return getSongElapsedSeconds(song) >= Math.max(song.durationInSec - thresholdSeconds, 0);
}

function isPrematureCloseError(error) {
  const message = String(error?.message || '');
  return (
    error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    message.includes('Premature close')
  );
}

function shouldIgnorePlayerPlaybackError(queue, error, currentSong) {
  if (!queue) {
    return true;
  }

  const errorPlaybackNonce = error?.resource?.metadata?.playbackNonce;
  if (
    typeof errorPlaybackNonce === 'number' &&
    errorPlaybackNonce !== queue.playbackNonce
  ) {
    return true;
  }

  if (queue.skipRequested || queue.isRecovering) {
    return true;
  }

  if (!isPrematureCloseError(error)) {
    return false;
  }

  const playerStatus = queue.player?.state?.status;
  return (
    playerStatus === AudioPlayerStatus.Idle ||
    Boolean(getTransitionSong(queue)) ||
    isNearTrackCompletion(currentSong)
  );
}

function shouldIgnoreTrackStreamError(queue, error, playbackNonce, currentSong) {
  if (!queue) {
    return true;
  }

  if (!isCurrentPlaybackAttempt(queue, playbackNonce, currentSong)) {
    return true;
  }

  if (queue.skipRequested || queue.isRecovering) {
    return true;
  }

  if (!isPrematureCloseError(error)) {
    return false;
  }

  const playerStatus = queue.player?.state?.status;
  return (
    playerStatus === AudioPlayerStatus.Idle ||
    Boolean(getTransitionSong(queue)) ||
    isNearTrackCompletion(currentSong)
  );
}

function destroyAudioStream(stream) {
  if (!stream || typeof stream.destroy !== 'function') {
    return;
  }

  try {
    stream.destroy();
  } catch {
    // Ignore cleanup errors for abandoned streams.
  }
}

async function resolveTracks(query, member) {
  const cachedTrack = getCachedTrack(query);
  if (cachedTrack) {
    return {
      type: 'single',
      label: cachedTrack.title,
      tracks: [hydrateCachedTrack(cachedTrack, member)]
    };
  }

  const spotifyType = play.sp_validate(query);
  if (spotifyType === 'track') {
    return resolveSpotifyTrackResult(query, member);
  }

  if (spotifyType === 'playlist' || spotifyType === 'album') {
    return resolveSpotifyCollectionResultWithFallback(query, member, spotifyType);
  }

  const type = play.yt_validate(query);

  if (type === 'video') {
    const track = await resolveDirectVideoTrack(query, member);
    cacheTrack(query, track);

    return {
      type: 'single',
      label: track.title,
      tracks: [track]
    };
  }

  if (type === 'playlist') {
    const playlist = await play.playlist_info(query, { incomplete: true });
    const videos = await playlist.all_videos();
    const tracks = videos
      .filter((video) => video && video.url)
      .map((video) => normalizeSong(video, member));

    return {
      type: 'playlist',
      label: playlist.title || 'Playlist',
      tracks,
      artwork: extractThumbnailUrl(playlist) || tracks[0]?.thumbnail || null,
      sourceLabel: 'YouTube Playlist',
      subtitle: playlist.channel?.name || playlist.channel?.title || null
    };
  }

  const resolvedSearchTrack = await resolveYouTubeSearchTrack(query, member);
  if (!resolvedSearchTrack) {
    return {
      type: 'single',
      label: query,
      tracks: []
    };
  }
  cacheTrack(query, resolvedSearchTrack);

  return {
    type: 'single',
    label: resolvedSearchTrack.title,
    tracks: [resolvedSearchTrack]
  };
}

async function resolveDirectVideoTrack(query, member) {
  const videoId = extractYouTubeVideoId(query);
  const canonicalUrl = videoId ? getCanonicalYouTubeUrl(videoId) : query;

  if (videoId) {
    try {
      const info = await getYouTubeInfo(videoId);
      const basicInfo = info?.basic_info || {};

      return normalizeSong(
        {
          id: basicInfo.id || videoId,
          title: basicInfo.title,
          url: canonicalUrl,
          durationInSec: basicInfo.duration,
          duration: basicInfo.duration,
          thumbnails: basicInfo.thumbnail
        },
        member
      );
    } catch {
      // Fall back to play-dl basic info when youtubei.js cannot resolve the video metadata.
    }
  }

  const info = await play.video_basic_info(canonicalUrl);
  return normalizeSong(
    {
      ...info.video_details,
      url: getPlayableUrl(info.video_details) || canonicalUrl
    },
    member
  );
}

async function resolveSpotifyTrackResult(query, member) {
  const spotifyTrack = await getSpotifyTrackMetadataWithFallback(query);
  const playableTrack = await findPlayableSongForSpotifyTrack(spotifyTrack, member);

  if (!playableTrack) {
    return {
      type: 'single',
      label: spotifyTrack.name || query,
      tracks: []
    };
  }

  cacheTrack(query, playableTrack);

  return {
    type: 'single',
    label: spotifyTrack.name || playableTrack.title,
    tracks: [playableTrack]
  };
}

async function resolveSpotifyCollectionResultWithFallback(query, member, spotifyType) {
  const spotifyCollection = await getSpotifyCollectionMetadataWithFallback(
    query,
    spotifyType
  );

  const playableTracks = (
    await Promise.all(
      spotifyCollection.tracks.map((track) => findPlayableSongForSpotifyTrack(track, member))
    )
  ).filter(Boolean);

  return {
    type: 'playlist',
    label: spotifyCollection.name,
    tracks: playableTracks,
    artwork: spotifyCollection.artwork || playableTracks[0]?.thumbnail || null,
    sourceLabel: spotifyCollection.sourceLabel,
    subtitle: spotifyCollection.subtitle || null
  };
}

async function getSpotifyTrackMetadataWithFallback(query) {
  if (hasSpotifyApiCredentials) {
    try {
      const spotifyResource = await play.spotify(query);
      if (spotifyResource?.type === 'track') {
        return spotifyResource;
      }
    } catch {
      // Fall back to public Spotify metadata when API credentials are unavailable or rejected.
    }
  }

  return getSpotifyTrackFromPublicMetadata(query);
}

async function getSpotifyCollectionMetadataWithFallback(query, spotifyType) {
  if (hasSpotifyApiCredentials) {
    const spotifyResource = await play.spotify(query);
    const spotifyTracks =
      spotifyType === 'playlist' || spotifyType === 'album'
        ? await spotifyResource.all_tracks()
        : [];

    return {
      name:
        spotifyTracks.length > SPOTIFY_COLLECTION_LIMIT
          ? `${spotifyResource.name} (first ${SPOTIFY_COLLECTION_LIMIT})`
          : spotifyResource.name,
      artwork: extractThumbnailUrl(spotifyResource) || null,
      sourceLabel: spotifyType === 'album' ? 'Spotify Album' : 'Spotify Playlist',
      subtitle: spotifyResource.owner?.name || spotifyResource.publisher || null,
      tracks: spotifyTracks
        .filter((track) => track && track.playable !== false)
        .slice(0, SPOTIFY_COLLECTION_LIMIT)
    };
  }

  return getSpotifyCollectionFromPublicMetadata(query, spotifyType);
}

async function getSpotifyTrackFromPublicMetadata(query) {
  try {
    const details = await spotifyUrlInfo.getDetails(query, getSpotifyRequestOptions());
    const preview = details?.preview ?? {};
    const firstTrack = Array.isArray(details?.tracks) ? details.tracks[0] : null;
    const normalizedTrack = normalizeSpotifyUrlInfoTrack(firstTrack, preview, query);

    if (normalizedTrack.name) {
      return normalizedTrack;
    }
  } catch {
    // Fall back to Spotify oEmbed if public metadata is unavailable.
  }

  return getSpotifyTrackFromOEmbed(query);
}

async function getSpotifyCollectionFromPublicMetadata(query, spotifyType) {
  const details = await spotifyUrlInfo.getDetails(query, getSpotifyRequestOptions());
  const preview = details?.preview ?? {};
  const tracks = Array.isArray(details?.tracks) ? details.tracks : [];

  if (tracks.length === 0) {
    throw new UserFacingError('I could not read any playable tracks from that Spotify link.');
  }

  const normalizedTracks = tracks
    .slice(0, SPOTIFY_COLLECTION_LIMIT)
    .map((track) => normalizeSpotifyUrlInfoTrack(track, preview, query))
    .filter((track) => track.name);

  if (normalizedTracks.length === 0) {
    throw new UserFacingError('I could not read any playable tracks from that Spotify link.');
  }

  return {
    name:
      tracks.length > SPOTIFY_COLLECTION_LIMIT
        ? `${preview.title || formatSpotifyResourceType(spotifyType)} (first ${SPOTIFY_COLLECTION_LIMIT})`
        : preview.title || formatSpotifyResourceType(spotifyType),
    artwork: preview.image || null,
    sourceLabel: spotifyType === 'album' ? 'Spotify Album' : 'Spotify Playlist',
    subtitle: preview.subtitle || preview.artist || null,
    tracks: normalizedTracks
  };
}

async function getSpotifyTrackFromOEmbed(query) {
  const response = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(query)}`,
    {
      headers: {
        'user-agent': 'Mozilla/5.0'
      }
    }
  );

  if (!response.ok) {
    throw new UserFacingError('I could not read metadata from that Spotify link.');
  }

  const data = await response.json();
  const title = typeof data?.title === 'string' ? data.title.trim() : '';
  const authorName =
    typeof data?.author_name === 'string' ? data.author_name.trim() : '';

  if (!title) {
    throw new UserFacingError('I could not extract the track name from that Spotify link.');
  }

  return {
    type: 'track',
    name: title,
    url: query,
    durationInSec: 0,
    artists: authorName
      ? authorName.split(',').map((name) => ({ name: name.trim() })).filter((artist) => artist.name)
      : [],
    thumbnail: data?.thumbnail_url ? { url: data.thumbnail_url } : undefined
  };
}

async function findPlayableSongForSpotifyTrack(spotifyTrack, member) {
  const searchQuery = buildSpotifySearchQuery(spotifyTrack);
  const result = await resolveYouTubeSearchTrack(searchQuery, member);

  if (!result) {
    return null;
  }

  if (!result.thumbnail && spotifyTrack?.thumbnail?.url) {
    result.thumbnail = spotifyTrack.thumbnail.url;
  }

  if ((!result.durationInSec || result.durationInSec <= 0) && spotifyTrack?.durationInSec) {
    result.durationInSec = spotifyTrack.durationInSec;
    result.durationLabel = formatDuration(spotifyTrack.durationInSec);
  }

  result.sourceLabel = 'Spotify';

  return result;
}

function buildSpotifySearchQuery(spotifyTrack) {
  const title =
    spotifyTrack?.name ||
    spotifyTrack?.title ||
    spotifyTrack?.track ||
    'Spotify track';
  const artists = Array.isArray(spotifyTrack?.artists)
    ? spotifyTrack.artists.map((artist) => artist?.name).filter(Boolean).join(' ')
    : '';

  return `${title} ${artists} audio`.trim();
}

function normalizeSpotifyUrlInfoTrack(track, preview, fallbackUrl) {
  const title =
    track?.name ||
    preview?.track ||
    preview?.title ||
    'Spotify track';
  const artists = splitSpotifyArtistNames(track?.artist || preview?.artist);

  return {
    type: 'track',
    name: title,
    title,
    url: track?.uri || preview?.link || fallbackUrl,
    durationInSec: normalizeSpotifyDuration(track?.duration),
    artists: artists.map((name) => ({ name })),
    thumbnail: preview?.image ? { url: preview.image } : undefined,
    playable: true
  };
}

function getSpotifyRequestOptions() {
  return {
    headers: {
      'user-agent': 'Mozilla/5.0'
    }
  };
}

function splitSpotifyArtistNames(value) {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .replace(/\s+(feat\.?|ft\.?)\s+/gi, ', ')
    .replace(/\s*&\s*/g, ', ')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function normalizeSpotifyDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value > 1000 ? Math.round(value / 1000) : Math.round(value);
}

function formatSpotifyResourceType(type) {
  return type === 'album' ? 'Spotify album' : 'Spotify playlist';
}

async function resolveYouTubeSearchTrack(query, member) {
  const results = await play.search(query, {
    limit: 1,
    source: { youtube: 'video' }
  });

  const firstResult = results[0];
  if (!firstResult) {
    return null;
  }

  const canonicalUrl =
    getPlayableUrl(firstResult) || getYouTubeWatchUrl(firstResult);

  if (!canonicalUrl) {
    return null;
  }

  const canonicalSong = normalizeSong(
    {
      ...firstResult,
      url: canonicalUrl
    },
    member
  );

  return canonicalSong.url ? canonicalSong : null;
}

function normalizeSong(song, member) {
  const url = getPlayableUrl(song);
  const thumbnail = extractThumbnailUrl(song);
  const durationInSec = Number(song.durationInSec || song.duration || 0);

  return {
    title: song.title || 'Unknown title',
    url,
    durationInSec,
    durationLabel: formatDuration(durationInSec),
    thumbnail,
    sourceLabel: song.sourceLabel || inferTrackSourceLabel(url),
    requestedById: member.user.id,
    requestedByName: member.displayName || member.user.username
  };
}

function extractThumbnailUrl(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value.thumbnail === 'string' && value.thumbnail.trim().length > 0) {
    return value.thumbnail.trim();
  }

  if (typeof value.thumbnail?.url === 'string' && value.thumbnail.url.trim().length > 0) {
    return value.thumbnail.url.trim();
  }

  if (Array.isArray(value.thumbnail) && value.thumbnail.length > 0) {
    const lastThumbnail = value.thumbnail[value.thumbnail.length - 1];
    if (typeof lastThumbnail?.url === 'string' && lastThumbnail.url.trim().length > 0) {
      return lastThumbnail.url.trim();
    }
  }

  if (Array.isArray(value.thumbnails) && value.thumbnails.length > 0) {
    const lastThumbnail = value.thumbnails[value.thumbnails.length - 1];
    if (typeof lastThumbnail?.url === 'string' && lastThumbnail.url.trim().length > 0) {
      return lastThumbnail.url.trim();
    }
  }

  if (Array.isArray(value.images) && value.images.length > 0) {
    const firstImage = value.images[0];
    if (typeof firstImage?.url === 'string' && firstImage.url.trim().length > 0) {
      return firstImage.url.trim();
    }
  }

  return null;
}

function cacheTrack(query, track) {
  if (!query || !track?.url) {
    return;
  }

  searchCache.set(query.toLowerCase(), {
    title: track.title,
    url: track.url,
    durationInSec: track.durationInSec,
    durationLabel: track.durationLabel,
    thumbnail: track.thumbnail,
    sourceLabel: track.sourceLabel,
    cachedAt: Date.now()
  });
}

function getCachedTrack(query) {
  const key = query.toLowerCase();
  const cached = searchCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }

  return cached;
}

function hydrateCachedTrack(track, member) {
  return {
    title: track.title,
    url: track.url,
    durationInSec: track.durationInSec,
    durationLabel: track.durationLabel,
    thumbnail: track.thumbnail,
    sourceLabel: track.sourceLabel,
    requestedById: member.user.id,
    requestedByName: member.displayName || member.user.username
  };
}

function getPlayableUrl(song) {
  if (!song) {
    return null;
  }

  if (typeof song.url === 'string' && song.url.trim().length > 0) {
    return song.url.trim();
  }

  if (typeof song.webpage_url === 'string' && song.webpage_url.trim().length > 0) {
    return song.webpage_url.trim();
  }

  if (typeof song.permalink === 'string' && song.permalink.trim().length > 0) {
    return song.permalink.trim();
  }

  if (typeof song.id === 'string' && song.id.trim().length > 0) {
    return `https://www.youtube.com/watch?v=${song.id.trim()}`;
  }

  if (typeof song.videoId === 'string' && song.videoId.trim().length > 0) {
    return `https://www.youtube.com/watch?v=${song.videoId.trim()}`;
  }

  if (typeof song.video_url === 'string' && song.video_url.trim().length > 0) {
    return song.video_url.trim();
  }

  if (typeof song.link === 'string' && song.link.trim().length > 0) {
    return song.link.trim();
  }

  return null;
}

function getYouTubeWatchUrl(song) {
  const id =
    (typeof song?.id === 'string' && song.id.trim()) ||
    (typeof song?.videoId === 'string' && song.videoId.trim()) ||
    null;

  return id ? getCanonicalYouTubeUrl(id) : null;
}

function getCanonicalYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function extractYouTubeVideoId(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return null;
  }

  const value = input.trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();

    if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
      const shortId = url.pathname.split('/').filter(Boolean)[0];
      return shortId || null;
    }

    if (hostname.endsWith('youtube.com')) {
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/')[2] || null;
      }

      if (url.pathname.startsWith('/embed/')) {
        return url.pathname.split('/')[2] || null;
      }

      return url.searchParams.get('v');
    }
  } catch {
    return null;
  }

  return null;
}

async function createAudioSource(url) {
  try {
    return await createYtDlpAudioSource(url);
  } catch {
    // Fall through to the next playback route.
  }

  try {
    return await createYouTubeJsAudioSource(url);
  } catch {
    // Fall through to the next playback route.
  }

  try {
    const playStream = await play.stream(url);

    return {
      stream: playStream.stream,
      inputType: playStream.type || StreamType.Arbitrary,
      provider: 'play-dl'
    };
  } catch {
    return {
      stream: createYouTubeAudioStream(url),
      inputType: StreamType.Arbitrary,
      provider: 'ytdl-core',
      warningMessage: 'Unable to play this link.'
    };
  }
}

async function createYtDlpAudioSource(url) {
  const stderrChunks = [];
  const processStream = new PassThrough();
  const subprocess = youtubeDl.exec(
    url,
    {
      format: 'bestaudio[acodec=opus]/bestaudio[acodec=mp4a.40.2]/bestaudio/best',
      output: '-',
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      preferFreeFormats: true
    },
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );

  if (!subprocess.stdout) {
    throw new Error('yt-dlp did not provide a stdout stream.');
  }

  subprocess.stderr?.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  subprocess.stdout.pipe(processStream);

  const stopSubprocess = () => {
    try {
      if (!subprocess.killed) {
        subprocess.kill();
      }
    } catch {
      // Ignore cleanup failures while tearing down yt-dlp.
    }
  };

  processStream.once('close', stopSubprocess);
  processStream.once('error', stopSubprocess);

  subprocess.catch((error) => {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const message = stderr || error?.stderr || error?.message || 'yt-dlp failed to stream this video.';
    processStream.emit('error', new Error(message));
    processStream.end();
  });

  await waitForReadableOrError(processStream, 1500);

  return {
    stream: processStream,
    inputType: StreamType.Arbitrary,
    provider: 'yt-dlp'
  };
}

function waitForReadableOrError(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('readable', onReadable);
      stream.off('error', onError);
    };

    const onReadable = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    stream.once('readable', onReadable);
    stream.once('error', onError);
  });
}

async function createYouTubeJsAudioSource(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    throw new Error('This is not a supported YouTube video URL.');
  }

  const info = await getYouTubeInfo(videoId);
  const webStream = await downloadBestYouTubeAudio(info);

  if (!webStream) {
    throw new Error('youtubei.js did not return an audio stream.');
  }

  return {
    stream: Readable.fromWeb(webStream),
    inputType: StreamType.Arbitrary,
    provider: 'youtubei.js'
  };
}

async function getYouTubeInfo(videoId) {
  const client = await getYoutubeClient();
  return client.getInfo(videoId);
}

async function getYoutubeClient() {
  if (!youtubeClientPromise) {
    youtubeClientPromise = import('youtubei.js')
      .then(({ Innertube }) => Innertube.create())
      .catch((error) => {
        youtubeClientPromise = null;
        throw error;
      });
  }

  return youtubeClientPromise;
}

async function downloadBestYouTubeAudio(info) {
  const profiles = [
    {
      type: 'audio',
      codec: 'opus',
      format: 'webm',
      quality: 'best'
    },
    {
      type: 'audio',
      codec: 'mp4a',
      format: 'mp4',
      quality: 'best'
    },
    {
      type: 'audio',
      format: 'any',
      quality: 'best'
    }
  ];

  let lastError = null;

  for (const profile of profiles) {
    try {
      return await info.download(profile);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('youtubei.js did not return an audio stream.');
}

async function prepareAudioSource(source) {
  if (source.inputType !== StreamType.Arbitrary) {
    return {
      ...source,
      inlineVolume: shouldUseInlineVolume(source.inputType)
    };
  }

  try {
    const probed = await demuxProbe(source.stream);
    return {
      stream: probed.stream,
      inputType: probed.type,
      provider: source.provider,
      inlineVolume: shouldUseInlineVolume(probed.type)
    };
  } catch {
    return {
      ...source,
      inlineVolume: shouldUseInlineVolume(StreamType.Arbitrary)
    };
  }
}

function shouldUseInlineVolume(inputType) {
  return ![
    StreamType.Opus,
    StreamType.OggOpus,
    StreamType.WebmOpus
  ].includes(inputType);
}

function createYouTubeAudioStream(url) {
  const options = {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25,
    dlChunkSize: 0,
    playerClients: YTDL_PLAYER_CLIENTS
  };

  if (ytdlAgent) {
    options.agent = ytdlAgent;
  } else if (process.env.YOUTUBE_COOKIE) {
    options.requestOptions = {
      headers: {
        cookie: process.env.YOUTUBE_COOKIE
      }
    };
  }

  return ytdl(url, options);
}

function createYtdlAgent(rawCookie) {
  const cookies = parseYtdlCookies(rawCookie);

  if (!cookies) {
    return null;
  }

  try {
    return ytdl.createAgent(cookies);
  } catch (error) {
    console.error('Failed to create ytdl cookie agent:', error);
    return null;
  }
}

function parseYtdlCookies(rawCookie) {
  if (!rawCookie) {
    return null;
  }

  const trimmed = rawCookie.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error('YOUTUBE_COOKIE is not valid JSON for ytdl-core cookies:', error);
    return null;
  }
}

async function handlePlaybackFailure(guildId, song, error, options = {}) {
  const queue = queues.get(guildId);
  if (!queue || queue.isRecovering) {
    return;
  }

  const { stopPlayer = true, continueImmediately = false } = options;
  clearPanelRefresh(queue);
  queue.isRecovering = true;
  queue.skipRequested = true;
  queue.currentSong = null;
  queue.pendingSong = null;
  queue.pauseOnStart = false;
  queue.isPlaying = false;
  queue.isPreparing = false;

  try {
    const hasMoreSongs = queue.songs.length > 0;
    const reason = formatMusicError(error);

    if (!hasMoreSongs) {
      await showPlaybackFailureOnPanel(queue, song, reason);
    }

    if (stopPlayer) {
      try {
        queue.player.stop(true);
      } catch {
        // Ignore player stop errors while recovering from a failed stream.
      }
      }

      if (continueImmediately) {
        if (hasMoreSongs) {
          queue.skipRequested = false;
          await playNext(guildId);
        } else {
          queue.skipRequested = false;
          scheduleIdleDisconnect(guildId);
        }
      }
  } finally {
    const activeQueue = queues.get(guildId);
    if (activeQueue) {
      activeQueue.isRecovering = false;
    }
  }
}

function stripRuntimeFields(song) {
  return {
    title: song.title,
    url: song.url,
    durationInSec: song.durationInSec,
    durationLabel: song.durationLabel,
    thumbnail: song.thumbnail,
    sourceLabel: song.sourceLabel,
    requestedById: song.requestedById,
    requestedByName: song.requestedByName
  };
}

function getRequiredMemberVoiceChannel(interaction) {
  const voiceChannel = interaction.member.voice.channel;

  if (!voiceChannel) {
    throw new UserFacingError('You need to join a voice channel first.');
  }

  return voiceChannel;
}

function getTransitionSong(queue) {
  if (!queue) {
    return null;
  }

  if (queue.pendingSong) {
    return queue.pendingSong;
  }

  if (queue.isPreparing && queue.currentSong) {
    return queue.currentSong;
  }

  return null;
}

function hasTrackContext(queue) {
  return Boolean(queue?.currentSong || getTransitionSong(queue));
}

function markCurrentSongPaused(queue) {
  const song = queue?.currentSong;
  if (!song || song.pausedAt) {
    return;
  }

  song.pausedAt = Date.now();
}

function markCurrentSongResumed(queue) {
  const song = queue?.currentSong;
  if (!song?.pausedAt) {
    return;
  }

  song.accumulatedPausedMs = (song.accumulatedPausedMs || 0) + (Date.now() - song.pausedAt);
  song.pausedAt = null;
}

function inferTrackSourceLabel(url) {
  if (typeof url !== 'string') {
    return 'Music';
  }

  if (url.includes('spotify.com')) {
    return 'Spotify';
  }

  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'YouTube';
  }

  return 'Link';
}

function getExistingQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) {
    throw new UserFacingError('There is no active music session right now.');
  }

  return queue;
}

function isQueueIdle(queue) {
  return (
    Boolean(queue) &&
    !queue.isPlaying &&
    !queue.currentSong &&
    !queue.pendingSong &&
    queue.songs.length === 0
  );
}

async function stopQueuePlayback(queue, preferredMessage = null) {
  if (!queue?.stayConnected) {
    await disableNowPlayingPanel(queue, preferredMessage);
    destroyQueue(queue.guildId);
    return false;
  }

  clearPanelRefresh(queue);
  clearIdleDisconnect(queue);
  queue.playbackNonce += 1;
  queue.skipRequested = true;
  queue.songs = [];
  queue.currentSong = null;
  queue.pendingSong = null;
  queue.pauseOnStart = false;
  queue.isPlaying = false;
  queue.isPreparing = false;

  try {
    queue.player.stop(true);
  } catch {
    // Ignore player stop errors while clearing an active 24/7 session.
  }

  queue.skipRequested = false;
  await disableNowPlayingPanel(queue, preferredMessage);
  return true;
}

function ensureSameVoiceChannel(interaction, queue) {
  const voiceChannel = getRequiredMemberVoiceChannel(interaction);

  if (voiceChannel.id !== queue.voiceChannelId) {
    throw new UserFacingError('You must be in the same voice channel as the bot to use this command.');
  }

  return voiceChannel;
}

function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) {
    return;
  }

  void disableNowPlayingPanel(queue);
  clearPanelRefresh(queue);
  clearIdleDisconnect(queue);
  queues.delete(guildId);
  queue.songs = [];
  queue.currentSong = null;
  queue.pendingSong = null;
  queue.pauseOnStart = false;
  queue.isPlaying = false;
  queue.isPreparing = false;

  try {
    queue.player.stop(true);
  } catch {
    // Ignore cleanup errors while shutting down the player.
  }

  try {
    queue.connection.destroy();
  } catch {
    // Ignore cleanup errors while tearing down the voice connection.
  }
}

function clearIdleDisconnect(queue) {
  if (!queue?.idleTimeout) {
    return;
  }

  clearTimeout(queue.idleTimeout);
  queue.idleTimeout = null;
}

function clearPanelRefresh(queue) {
  if (!queue?.panelRefreshTimeout) {
    return;
  }

  clearTimeout(queue.panelRefreshTimeout);
  queue.panelRefreshTimeout = null;
}

function scheduleNowPlayingPanelRefresh(queue) {
  if (!queue) {
    return;
  }

  clearPanelRefresh(queue);
  queue.panelRefreshTimeout = setTimeout(() => {
    queue.panelRefreshTimeout = null;

    const activeQueue = queues.get(queue.guildId);
    if (!activeQueue) {
      return;
    }

    const transitionSong = getTransitionSong(activeQueue);
    if (transitionSong) {
      void previewUpcomingSongPanel(activeQueue, transitionSong);
      return;
    }

    if (activeQueue.currentSong) {
      void syncNowPlayingPanel(activeQueue);
    }
  }, 150);
}

function scheduleIdleDisconnect(guildId) {
  const queue = queues.get(guildId);
  if (!queue) {
    return;
  }

  clearIdleDisconnect(queue);
  if (queue.stayConnected) {
    return;
  }

  queue.idleTimeout = setTimeout(async () => {
    const activeQueue = queues.get(guildId);
    if (!activeQueue || activeQueue.stayConnected || !isQueueIdle(activeQueue)) {
      return;
    }

    const channel = await getQueueTextChannel(activeQueue);
    if (channel) {
      await channel
        .send({
          embeds: [
            createInfoEmbed(
              'Disconnected for Inactivity',
              'I left the voice channel after two minutes of inactivity.',
              COLORS.warning
            )
          ]
        })
        .catch(() => null);
    }

    destroyQueue(guildId);
  }, IDLE_DISCONNECT_MS);
}

async function getQueueTextChannel(queue) {
  if (!queue?.textChannelId) {
    return null;
  }

  const channel =
    client.channels.cache.get(queue.textChannelId) ||
    (await client.channels.fetch(queue.textChannelId).catch(() => null));

  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    return null;
  }

  return channel;
}

async function syncNowPlayingPanel(queue, preferredMessage = null) {
  if (!queue?.currentSong) {
    return null;
  }

  return enqueuePanelUpdate(queue, async () => {
    const channel = await getQueueTextChannel(queue);
    if (!channel) {
      return null;
    }

    const payload = {
      embeds: [createNowPlayingEmbed(queue.currentSong, queue)],
      components: [createPlaybackControls(queue)]
    };

    const { targetMessage } = await resolvePanelTarget(queue, channel, preferredMessage);

    if (targetMessage && targetMessage.editable) {
      const updatedMessage = await targetMessage.edit(payload).catch(() => null);
      if (updatedMessage) {
        queue.panelMessageId = updatedMessage.id;
        return updatedMessage;
      }
    }

    const sentMessage = await channel.send(payload).catch(() => null);
    if (sentMessage) {
      queue.panelMessageId = sentMessage.id;
    }

    return sentMessage;
  });
}

async function disableNowPlayingPanel(queue, preferredMessage = null) {
  if (!queue?.textChannelId) {
    return;
  }

  await enqueuePanelUpdate(queue, async () => {
    const channel = await getQueueTextChannel(queue);
    if (!channel) {
      queue.panelMessageId = null;
      return null;
    }

    const { targetMessage, stalePreferredMessage } = await resolvePanelTarget(
      queue,
      channel,
      preferredMessage
    );

    if (targetMessage && targetMessage.editable) {
      await targetMessage.edit({ components: [] }).catch(() => null);
    }

    if (
      stalePreferredMessage &&
      stalePreferredMessage.id !== targetMessage?.id &&
      stalePreferredMessage.editable
    ) {
      await stalePreferredMessage.edit({ components: [] }).catch(() => null);
    }

    queue.panelMessageId = null;
    return null;
  });
}

async function showPlaybackFailureOnPanel(queue, song, reason) {
  return enqueuePanelUpdate(queue, async () => {
    const channel = await getQueueTextChannel(queue);
    if (!channel) {
      return null;
    }

    const failureEmbed = createPlaybackFailureEmbed(song, reason);
    const { targetMessage: panelMessage } = await resolvePanelTarget(queue, channel, null);

    if (panelMessage && panelMessage.editable) {
      const updated = await panelMessage
        .edit({
          embeds: [failureEmbed],
          components: []
        })
        .catch(() => null);

      if (updated) {
        queue.panelMessageId = updated.id;
        return updated;
      }
    }

    const sentMessage = await channel.send({ embeds: [failureEmbed] }).catch(() => null);
    if (sentMessage) {
      queue.panelMessageId = sentMessage.id;
    }

    return sentMessage;
  });
}

async function resolvePanelTarget(queue, channel, preferredMessage = null) {
  const storedMessage = queue.panelMessageId
    ? await channel.messages.fetch(queue.panelMessageId).catch(() => null)
    : null;
  const candidateMessage =
    preferredMessage?.channelId === queue.textChannelId ? preferredMessage : null;

  if (
    candidateMessage &&
    storedMessage &&
    candidateMessage.id !== storedMessage.id &&
    candidateMessage.editable
  ) {
    await candidateMessage.edit({ components: [] }).catch(() => null);
  }

  return {
    targetMessage: storedMessage || candidateMessage || null,
    stalePreferredMessage:
      candidateMessage && storedMessage && candidateMessage.id !== storedMessage.id
        ? candidateMessage
        : null
  };
}

function enqueuePanelUpdate(queue, task) {
  if (!queue) {
    return Promise.resolve(null);
  }

  const chain = queue.panelUpdatePromise || Promise.resolve();
  const next = chain.catch(() => null).then(task);
  queue.panelUpdatePromise = next.catch(() => null);
  return next;
}

function validateVoicePermissions(interaction, voiceChannel) {
  const botMember = interaction.guild.members.me;

  if (!botMember) {
    throw new UserFacingError('I could not verify the bot permissions in this server.');
  }

  const permissions = voiceChannel.permissionsFor(botMember);
  if (!permissions) {
    throw new UserFacingError('I could not read the bot permissions for this voice channel.');
  }

  const missing = [];

  if (!permissions.has(PermissionFlagsBits.Connect)) {
    missing.push('Connect');
  }

  if (!permissions.has(PermissionFlagsBits.Speak)) {
    missing.push('Speak');
  }

  if (missing.length > 0) {
    throw new UserFacingError(
      `The bot needs these permissions in **${voiceChannel.name}**: ${missing.join(', ')}.`
    );
  }

  if (voiceChannel.full) {
    throw new UserFacingError(`**${voiceChannel.name}** is currently full.`);
  }

  if (!voiceChannel.joinable) {
    throw new UserFacingError(
      `Discord is currently treating **${voiceChannel.name}** as not joinable for the bot.`
    );
  }

  if (
    voiceChannel.type !== ChannelType.GuildStageVoice &&
    !voiceChannel.speakable
  ) {
    throw new UserFacingError(
      `Discord is currently treating the bot as unable to speak in **${voiceChannel.name}**.`
    );
  }
}

function formatLoopMode(mode) {
  switch (mode) {
    case 'track':
      return 'Track';
    case 'queue':
      return 'Queue';
    default:
      return 'Off';
  }
}

function isQueuePaused(queue) {
  return (
    queue?.player?.state?.status === AudioPlayerStatus.Paused ||
    queue?.player?.state?.status === AudioPlayerStatus.AutoPaused
  );
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) {
    return '00:00';
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

async function replyError(interaction, message) {
  const embeds = [createInfoEmbed('Error', message, COLORS.danger)];

  if (interaction.deferred) {
    await interaction.editReply({ embeds }).catch(() => null);
    return;
  }

  const payload = {
    embeds,
    flags: MessageFlags.Ephemeral
  };

  if (interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }

  await interaction.reply(payload).catch(() => null);
}

async function replyButtonError(interaction, message) {
  await interaction
    .followUp({
      embeds: [createInfoEmbed('Error', message, COLORS.danger)],
      flags: MessageFlags.Ephemeral
    })
    .catch(() => null);
}

function formatMusicError(error) {
  if (error instanceof UserFacingError) {
    return error.message;
  }

  const message = String(error?.message || error || '');

  if (
    message.includes('Captcha page') ||
    message.includes('Sign in to confirm') ||
    message.includes('unusual traffic')
  ) {
    return 'YouTube is blocking requests right now. Try again later or use a different video.';
  }

  if (
    message.includes('Failed to find any playable formats') ||
    message.includes('No such format found') ||
    message.includes('Could not extract functions')
  ) {
    return 'YouTube did not provide a playable format for this track. Try another link or search.';
  }

  if (
    error?.code === 'ERR_INVALID_URL' ||
    message.includes('Invalid URL')
  ) {
    return 'I could not extract a valid playback URL for this video. Try another link or search.';
  }

  if (
    message.includes('supported YouTube video URL') ||
    message.includes('This is not a supported YouTube video URL')
  ) {
    return 'That link is not a supported YouTube video URL.';
  }

  if (
    message.includes('did not return an audio stream') ||
    message.includes('audio stream')
  ) {
    return 'I could not get a valid audio stream for this video.';
  }

  if (
    message.includes('Video unavailable') ||
    message.includes('This video is unavailable') ||
    message.includes('UNPLAYABLE')
  ) {
    return 'This video is currently unavailable on YouTube.';
  }

  if (
    message.includes('No valid URL to decipher') ||
    message.includes('Streaming data not available')
  ) {
    return 'YouTube did not return a valid stream URL for this video right now.';
  }

  if (
    message.includes('Spotify') ||
    message.includes('spotify') ||
    message.includes('oembed')
  ) {
    return 'I could not read this Spotify link or convert it into a playable result.';
  }

  if (
    message.includes('yt-dlp failed') ||
    message.includes('yt-dlp') ||
    message.includes('Permission denied')
  ) {
    return 'The fallback YouTube playback route failed for this link.';
  }

  if (
    message.includes('Cannot find module \'opusscript\'') ||
    message.includes('Cannot find module \'node-opus\'') ||
    message.includes('Cannot find module')
  ) {
    return 'Audio dependencies are missing in this project. Run `npm install` and restart the bot.';
  }

  if (
    error?.code === 'ABORT_ERR' ||
    message.includes('Voice connection not ready') ||
    message.includes('timed out') ||
    message.includes('Could not connect') ||
    message.includes('The operation was aborted')
  ) {
    return 'I could not finish the voice connection in the channel. Check the channel state and try again.';
  }

  if (
    message.includes('Initial Player Response Data is undefined') ||
    message.includes('While getting info from url') ||
    message.includes('This is not a YouTube Watch URL')
  ) {
    return 'I could not read that YouTube link or its track details. Try another search or a direct link.';
  }

  return 'An unexpected music error occurred while handling your request.';
}

function createHealthServer() {
  const rawPort = process.env.PORT;
  const port = Number(rawPort);

  if (!rawPort || !Number.isInteger(port) || port <= 0) {
    return null;
  }

  const server = http.createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, message: 'Not found' }));
      return;
    }

    const ready = client.isReady() && !isShuttingDown;
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: ready,
        status: ready ? 'ready' : isShuttingDown ? 'shutting_down' : 'starting'
      })
    );
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Railway healthcheck server listening on port ${port}`);
  });

  server.on('error', (error) => {
    console.error('Healthcheck server error:', error);
  });

  return server;
}

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`${signal} received. Shutting down gracefully...`);

  for (const guildId of [...queues.keys()]) {
    destroyQueue(guildId);
  }

  if (healthServer) {
    await new Promise((resolve) => healthServer.close(() => resolve()));
  }

  try {
    client.destroy();
  } catch (error) {
    console.error('Error while destroying Discord client during shutdown:', error);
  }

  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

client
  .login(process.env.TOKEN)
  .catch((error) => {
    console.error('Discord login failed:', error);
    void shutdown('LOGIN_FAILURE', 1);
  });



