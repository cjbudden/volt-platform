// ============================================================================
//  BACKGROUND PLAYBACK: the system's view of the player.
//
//  When VoltPlayerOptions.backgroundPlayback is on, the player binds this
//  service and offers it its MediaSession. Media3 then shows the media
//  notification and lock screen controls, and keeps the process in the
//  foreground while it plays, so radio carries on with the screen off.
//  Declared in the SDK's manifest; nothing to add to the app's.
// ============================================================================
package com.volt.player

import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class VoltPlaybackService : MediaSessionService() {
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = offered

    override fun onDestroy() {
        // The session belongs to the VoltPlayer that made it; it releases it in destroy().
        offered?.let { removeSession(it) }
        super.onDestroy()
    }

    companion object {
        @Volatile private var offered: MediaSession? = null

        internal fun offer(session: MediaSession) { offered = session }

        internal fun release(session: MediaSession?) { if (session != null && offered === session) offered = null }
    }
}
