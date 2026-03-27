const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');

const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245
};

function createInfoEmbed(title, description, color = COLORS.primary) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function createNowPlayingEmbed(song, queue) {
  const upcomingSong = queue.songs[0] || null;
  const statusLabel = isQueuePaused(queue) ? 'Paused' : 'Playing';
  const embed = new EmbedBuilder()
    .setColor(isQueuePaused(queue) ? COLORS.warning : COLORS.primary)
    .setTitle(isQueuePaused(queue) ? 'Playback Paused' : 'Now Playing')
    .setDescription(
      `**[${song.title}](${song.url})**\n${buildPlaybackProgressLine(song)}\nStatus: **${statusLabel}**`
    )
    .addFields(
      {
        name: 'Duration',
        value: song.durationLabel,
        inline: true
      },
      {
        name: 'Progress',
        value: `${formatDuration(getElapsedSeconds(song))} / ${song.durationLabel}`,
        inline: true
      },
      {
        name: 'Volume',
        value: `${queue.volume}%`,
        inline: true
      },
      {
        name: 'Loop',
        value: formatLoopMode(queue.loopMode),
        inline: true
      },
      {
        name: '24/7 Mode',
        value: formatStayConnectedMode(queue.stayConnected),
        inline: true
      },
      {
        name: 'Requested By',
        value: song.requestedById ? `<@${song.requestedById}>` : song.requestedByName || 'Unknown',
        inline: true
      },
      {
        name: 'Up Next',
        value: upcomingSong ? `[${upcomingSong.title}](${upcomingSong.url})` : 'Nothing queued',
        inline: true
      }
    )
    .setFooter({
      text: buildNowPlayingFooter(song, queue)
    })
    .setTimestamp();

  if (song.thumbnail) {
    embed.setThumbnail(song.thumbnail);
  }

  return embed;
}

function createUpNextEmbed(song, queue) {
  const remainingAfterThis = Math.max(queue.songs.length - 1, 0);
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('Loading Next Track')
    .setDescription(
      `**[${song.title}](${song.url})**\n${
        queue.pauseOnStart
          ? 'Switching tracks now... playback will start paused.'
          : 'Switching tracks now...'
      }`
    )
    .addFields(
      {
        name: 'Duration',
        value: song.durationLabel,
        inline: true
      },
      {
        name: 'Requested By',
        value: song.requestedById ? `<@${song.requestedById}>` : song.requestedByName || 'Unknown',
        inline: true
      },
      {
        name: 'Remaining After This',
        value: `${remainingAfterThis} track(s)`,
        inline: true
      }
    )
    .setFooter({
      text: buildTransitionFooter(song, queue)
    })
    .setTimestamp();

  if (song.thumbnail) {
    embed.setThumbnail(song.thumbnail);
  }

  return embed;
}

function createAddedToQueueEmbed(resolved, queue, voiceChannel) {
  const isPlaylist = resolved.type === 'playlist';
  const primarySong = resolved.tracks[0];
  const displayLabel = formatDisplayCollectionLabel(resolved.label);
  const collectionArtwork = resolved.artwork || primarySong?.thumbnail || null;
  const sourceLabel = resolved.sourceLabel || (isPlaylist ? 'Playlist' : primarySong?.sourceLabel || 'Track');
  const totalImported = resolved.tracks.length;
  const queueStatus = queue.currentSong
    ? 'Joins the live session instantly.'
    : 'Starts the session immediately.';
  const accentColor = getCollectionAccentColor(sourceLabel);
  const embed = new EmbedBuilder()
    .setColor(accentColor)
    .setTitle(isPlaylist ? displayLabel : primarySong.title)
    .setAuthor({
      name: isPlaylist ? `${sourceLabel} • Queue Drop` : `${sourceLabel} • Locked In`
    })
    .setDescription(
      isPlaylist
        ? buildPlaylistAddedDescription({
            totalImported,
            voiceChannelName: voiceChannel.name,
            queueSize: queue.songs.length,
            queueStatus,
            firstTrack: primarySong,
            requestedById: primarySong?.requestedById,
            requestedByName: primarySong?.requestedByName
          })
        : buildTrackAddedDescription({
            song: primarySong,
            voiceChannelName: voiceChannel.name,
            queueSize: queue.songs.length,
            queueStatus
          })
    )
    .setTimestamp();

  if (isPlaylist && resolved.subtitle) {
    embed.addFields({
      name: 'Curated By',
      value: resolved.subtitle,
      inline: false
    });
  } else if (!isPlaylist) {
    embed.addFields(
      {
        name: 'Duration',
        value: primarySong.durationLabel,
        inline: true
      },
      {
        name: 'Requested By',
        value: primarySong?.requestedById
          ? `<@${primarySong.requestedById}>`
          : primarySong?.requestedByName || 'Unknown',
        inline: true
      }
    );
  }

  if (collectionArtwork) {
    embed.setThumbnail(collectionArtwork);
  }

  embed.setFooter({
    text: isPlaylist
      ? `${sourceLabel} • ${queue.songs.length} tracks waiting`
      : `${sourceLabel} • Ready in queue`
  });

  return embed;
}

function buildPlaylistAddedDescription({
  totalImported,
  voiceChannelName,
  queueSize,
  queueStatus,
  firstTrack,
  requestedById,
  requestedByName
}) {
  const requestedBy = requestedById ? `<@${requestedById}>` : requestedByName || 'Unknown';
  const openingTrack = firstTrack ? `[${firstTrack.title}](${firstTrack.url})` : 'No playable opening track';

  return [
    `Imported **${totalImported}** tracks into the queue.`,
    '',
    `**Voice**\n${voiceChannelName}`,
    '',
    `**Queue Shape**\n${queueSize} tracks lined up`,
    '',
    `**Opening Move**\n${openingTrack}`,
    '',
    `**Requested By**\n${requestedBy}`,
    '',
    `**Status**\n${queueStatus}`
  ].join('\n');
}

function buildTrackAddedDescription({ song, voiceChannelName, queueSize, queueStatus }) {
  return [
    `**[${song.title}](${song.url})**`,
    '',
    `**Voice**\n${voiceChannelName}`,
    '',
    `**Duration**\n${song.durationLabel}`,
    '',
    `**Queue Shape**\n${queueSize} tracks lined up`,
    '',
    `**Status**\n${queueStatus}`
  ].join('\n');
}

function getCollectionAccentColor(sourceLabel) {
  const normalized = String(sourceLabel || '').toLowerCase();

  if (normalized.includes('spotify')) {
    return 0x1db954;
  }

  if (normalized.includes('youtube')) {
    return 0xff3b30;
  }

  return COLORS.success;
}

function createPlaybackFailureEmbed(song, reason) {
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('Unable to Play Track')
    .setDescription(`**${song.title}**\n${reason}`)
    .setFooter({
      text: 'Try another link or use /leave to disconnect.'
    })
    .setTimestamp();
}

function createQueueEmbed(queue) {
  const transitionSong = getTransitionSong(queue);
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Queue')
    .setDescription(buildQueueDescription(queue))
    .addFields(
      {
        name: 'Upcoming Tracks',
        value: String(queue.songs.length),
        inline: true
      },
      {
        name: 'Volume',
        value: `${queue.volume}%`,
        inline: true
      },
      {
        name: 'Loop Mode',
        value: formatLoopMode(queue.loopMode),
        inline: true
      },
      {
        name: '24/7 Mode',
        value: formatStayConnectedMode(queue.stayConnected),
        inline: true
      }
    )
    .setTimestamp();

  if (transitionSong?.thumbnail || queue.currentSong?.thumbnail) {
    embed.setThumbnail(transitionSong?.thumbnail || queue.currentSong?.thumbnail);
  }

  return embed;
}

function createPlaybackControls(queue) {
  const transitionSong = getTransitionSong(queue);
  const isSwitchingTracks = Boolean(transitionSong);
  const canPause = Boolean(queue.currentSong || transitionSong);
  const canSkip = Boolean(queue.currentSong) && !isSwitchingTracks && queue.songs.length > 0;
  const canStop = Boolean(queue.currentSong || transitionSong || queue.songs.length > 0);
  const pauseLabel = isQueuePaused(queue) || queue.pauseOnStart ? 'Resume' : 'Pause';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music:pause-toggle')
      .setLabel(pauseLabel)
      .setStyle(isQueuePaused(queue) ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canPause),
    new ButtonBuilder()
      .setCustomId('music:next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canSkip),
    new ButtonBuilder()
      .setCustomId('music:queue')
      .setLabel('Queue')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canStop)
  );
}

function buildNowPlayingFooter(song, queue) {
  const parts = [`Source: ${song.sourceLabel || 'Music'}`];
  const playbackRoute = formatPlaybackProvider(queue?.currentSong?.playbackProvider);
  if (playbackRoute) {
    parts.push(`Playback: ${playbackRoute}`);
  }

  parts.push('Use the buttons below for quick controls');
  return parts.join(' • ');
}

function buildTransitionFooter(song, queue) {
  const parts = [`Source: ${song.sourceLabel || 'Music'}`];
  const playbackRoute = formatPlaybackProvider(queue?.currentSong?.playbackProvider);
  if (playbackRoute) {
    parts.push(`Last route: ${playbackRoute}`);
  }

  return parts.join(' • ');
}

function buildQueueDescription(queue) {
  const lines = [];
  const transitionSong = getTransitionSong(queue);

  if (transitionSong) {
    lines.push(
      `**Loading Next:** [${transitionSong.title}](${transitionSong.url}) \`${transitionSong.durationLabel}\``
    );
  } else if (queue.currentSong) {
    lines.push(
      `**Now Playing:** [${queue.currentSong.title}](${queue.currentSong.url}) \`${queue.currentSong.durationLabel}\``
    );
  }

  if (queue.songs.length === 0) {
    lines.push('No additional tracks are queued.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('**Up Next:**');
  lines.push(
    ...queue.songs
      .slice(0, 10)
      .map(
        (song, index) =>
          `${index + 1}. [${song.title}](${song.url}) \`${song.durationLabel}\``
      )
  );

  if (queue.songs.length > 10) {
    lines.push(`... and ${queue.songs.length - 10} more track(s).`);
  }

  return lines.join('\n');
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

function formatStayConnectedMode(enabled) {
  return enabled ? 'Enabled' : 'Disabled';
}

function formatDisplayCollectionLabel(label) {
  return String(label || '')
    .replace(/\s*\(first\s+\d+\)\s*/i, '')
    .trim();
}

function formatPlaybackProvider(provider) {
  switch (provider) {
    case 'yt-dlp':
      return 'YT-DLP';
    case 'youtubei.js':
      return 'YouTube.js';
    case 'play-dl':
      return 'play-dl';
    case 'ytdl-core':
      return 'ytdl-core';
    default:
      return null;
  }
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

function isQueuePaused(queue) {
  return (
    queue?.player?.state?.status === AudioPlayerStatus.Paused ||
    queue?.player?.state?.status === AudioPlayerStatus.AutoPaused
  );
}

function buildPlaybackProgressLine(song) {
  const elapsed = getElapsedSeconds(song);
  const total = song.durationInSec || 0;

  if (!total) {
    return 'Progress unavailable for this track.';
  }

  const ratio = Math.max(0, Math.min(1, elapsed / total));
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  const bar = `${'='.repeat(filled)}${' '.repeat(empty)}`;

  return `\`${formatDuration(elapsed)} [${bar}] ${song.durationLabel}\``;
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

function getElapsedSeconds(song) {
  if (!song.startedAt) {
    return 0;
  }

  const referenceTime = song.pausedAt || Date.now();
  const accumulatedPausedMs = song.accumulatedPausedMs || 0;
  const elapsedMs = Math.max(0, referenceTime - song.startedAt - accumulatedPausedMs);

  return Math.min(
    Math.floor(elapsedMs / 1000),
    song.durationInSec || 0
  );
}

module.exports = {
  COLORS,
  createAddedToQueueEmbed,
  createInfoEmbed,
  createNowPlayingEmbed,
  createPlaybackControls,
  createPlaybackFailureEmbed,
  createQueueEmbed,
  createUpNextEmbed,
  formatDuration,
  formatLoopMode,
  getTransitionSong,
  isQueuePaused
};
