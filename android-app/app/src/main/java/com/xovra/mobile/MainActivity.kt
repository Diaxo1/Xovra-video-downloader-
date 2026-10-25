package com.xovra.mobile

import android.content.ContentValues
import android.content.Intent
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.chaquo.python.android.AndroidPlatform
import com.chaquo.python.Python
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.Locale

private val Ink = Color(0xFFF2F1E9)
private val Muted = Color(0xFFB8BBAF)
private val Background = Color(0xFF171A14)
private val SurfaceColor = Color(0xFF22261E)
private val Lime = Color(0xFFC8F060)
private val Border = Color(0xFF41483A)
private val Warning = Color(0xFFE5C877)

private data class MediaFormat(
    val id: String,
    val label: String,
    val ext: String,
    val audioOnly: Boolean,
    val size: Long?
)

private data class MediaItem(val title: String, val source: String, val formats: List<MediaFormat>)

class MainActivity : ComponentActivity() {
    private val history = mutableStateListOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        val shared = if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        } else ""
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(
                primary = Lime,
                onPrimary = Color(0xFF263116),
                background = Background,
                surface = SurfaceColor,
                onBackground = Ink,
                onSurface = Ink,
                outline = Border
            )) {
                XovraScreen(
                    initialLink = shared,
                    history = history,
                    onAnalyze = { url, done -> analyze(url, done) },
                    onDownload = { url, format, done -> download(url, format, done) }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    private fun analyze(url: String, done: (Result<MediaItem>) -> Unit) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val raw = Python.getInstance().getModule("xovra_mobile").callAttr("analyze", url).toString()
                    val json = JSONObject(raw)
                    val formatsJson = json.getJSONArray("formats")
                    val formats = (0 until formatsJson.length()).map { index ->
                        val row = formatsJson.getJSONObject(index)
                        MediaFormat(row.getString("id"), row.getString("label"), row.optString("ext", "mp4"), row.optBoolean("audioOnly"), if (row.has("size") && !row.isNull("size")) row.getLong("size") else null)
                    }
                    if (formats.isEmpty()) error("This link didn’t return a single-file MP4/WebM format. Try a different source or quality.")
                    MediaItem(json.optString("title", "Untitled media"), json.optString("source", "Media source"), formats)
                }
            }
            done(result)
        }
    }

    private fun download(url: String, format: MediaFormat, done: (Result<String>) -> Unit) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val work = File(cacheDir, "xovra-downloads")
                    val raw = Python.getInstance().getModule("xovra_mobile")
                        .callAttr("download", url, format.id, work.absolutePath).toString()
                    val response = JSONObject(raw)
                    val sourceFile = File(response.getString("path"))
                    check(sourceFile.isFile) { "The downloaded file could not be found." }
                    val name = sourceFile.name.replace(Regex("[^A-Za-z0-9._ ()-]"), "_").take(140).ifBlank { "Xovra.${format.ext}" }
                    val mime = when (format.ext.lowercase(Locale.ROOT)) {
                        "mp4", "m4v" -> "video/mp4"
                        "webm" -> "video/webm"
                        "m4a" -> "audio/mp4"
                        "mp3" -> "audio/mpeg"
                        "opus" -> "audio/ogg"
                        else -> "application/octet-stream"
                    }
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Xovra")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: error("Android couldn’t create the Downloads file.")
                    try {
                        contentResolver.openOutputStream(uri)?.use { output -> sourceFile.inputStream().use { it.copyTo(output) } }
                            ?: error("Android couldn’t open the Downloads file.")
                        contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                        sourceFile.delete()
                        "Saved to Downloads/Xovra/$name"
                    } catch (error: Throwable) {
                        contentResolver.delete(uri, null, null)
                        throw error
                    }
                }
            }
            done(result)
        }
    }
}

@Composable
private fun XovraScreen(
    initialLink: String,
    history: MutableList<String>,
    onAnalyze: (String, (Result<MediaItem>) -> Unit) -> Unit,
    onDownload: (String, MediaFormat, (Result<String>) -> Unit) -> Unit
) {
    var url by remember { mutableStateOf(initialLink) }
    var loading by remember { mutableStateOf(false) }
    var downloading by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var media by remember { mutableStateOf<MediaItem?>(null) }
    var savedMessage by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }

    Surface(modifier = Modifier.fillMaxSize(), color = Background) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            item {
                Column(modifier = Modifier.padding(top = 28.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Surface(shape = RoundedCornerShape(13.dp), color = Lime, modifier = Modifier.size(42.dp)) {
                            androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) {
                                Text("X", color = Color(0xFF263116), fontSize = 23.sp, fontWeight = FontWeight.Black)
                            }
                        }
                        Text("xovra", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = (-1).sp)
                        Spacer(Modifier.weight(1f))
                        Text("ANDROID · BETA", color = Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(Modifier.height(26.dp))
                    Text("Your media.\nYour call.", color = Ink, fontSize = 38.sp, lineHeight = 39.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1.7).sp)
                    Text("Paste a link, choose a format, and save it on your phone.", color = Muted, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 10.dp))
                }
            }
            item {
                Surface(color = Color(0xFF302C1D), shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Color(0xFF71643B))) {
                    Text("Downloads run on this device. Only save media you have permission to use.", color = Warning, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.padding(14.dp))
                }
            }
            item {
                Surface(color = SurfaceColor, shape = RoundedCornerShape(22.dp), border = BorderStroke(1.dp, Border)) {
                    Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Analyze a link", color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        OutlinedTextField(
                            value = url,
                            onValueChange = { url = it; message = null; savedMessage = null },
                            modifier = Modifier.fillMaxWidth(),
                            minLines = 2,
                            label = { Text("Video or audio URL") },
                            placeholder = { Text("https://") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            shape = RoundedCornerShape(12.dp)
                        )
                        Button(
                            onClick = {
                                if (url.isBlank()) { message = "Paste a link first."; return@Button }
                                loading = true; message = null; media = null; savedMessage = null
                                onAnalyze(url.trim()) { result ->
                                    loading = false
                                    result.onSuccess { media = it; if (url !in history) history.add(0, url); while (history.size > 8) history.removeAt(history.lastIndex) }
                                        .onFailure { message = it.message ?: "Couldn’t read this media link." }
                                }
                            },
                            enabled = !loading && !downloading,
                            modifier = Modifier.fillMaxWidth().height(54.dp),
                            shape = RoundedCornerShape(13.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Color(0xFF263116))
                        ) {
                            if (loading) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color(0xFF263116), strokeWidth = 2.dp)
                            else Text("Analyze link  →", fontWeight = FontWeight.Bold)
                        }
                        message?.let { Text(it, color = Color(0xFFFF9C84), fontSize = 14.sp) }
                    }
                }
            }
            val currentMedia = media
            if (currentMedia != null) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Available formats", color = Ink, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                        Text(currentMedia.title, color = Muted, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(currentMedia.source, color = Muted, fontSize = 12.sp)
                    }
                }
                items(currentMedia.formats) { format ->
                    val active = selected == format.id
                    OutlinedButton(
                        onClick = { selected = format.id },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.dp, if (active) Lime else Border),
                        colors = ButtonDefaults.outlinedButtonColors(containerColor = if (active) Color(0xFF39442A) else SurfaceColor, contentColor = Ink)
                    ) {
                        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(format.label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                            Text(format.size?.let { "About ${formatBytes(it)}" } ?: if (format.audioOnly) "Audio file" else "Size from source", color = Muted, fontSize = 12.sp)
                        }
                    }
                }
                item {
                    Button(
                        onClick = {
                            val format = currentMedia.formats.firstOrNull { it.id == selected } ?: currentMedia.formats.first()
                            downloading = true; savedMessage = null; message = null
                            onDownload(url.trim(), format) { result ->
                                downloading = false
                                result.onSuccess { savedMessage = it }.onFailure { message = it.message ?: "Download failed." }
                            }
                        },
                        enabled = !downloading,
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                        shape = RoundedCornerShape(13.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Lime, contentColor = Color(0xFF263116))
                    ) {
                        if (downloading) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color(0xFF263116), strokeWidth = 2.dp)
                        else Text("Download to phone  ↓", fontWeight = FontWeight.Bold)
                    }
                    savedMessage?.let { Text(it, color = Lime, fontSize = 14.sp) }
                    message?.let { Text(it, color = Color(0xFFFF9C84), fontSize = 14.sp) }
                }
            }
            item {
                Column(modifier = Modifier.padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Recent links", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    if (history.isEmpty()) Text("Links you check will appear here.", color = Muted, fontSize = 14.sp)
                    history.take(5).forEach { link ->
                        Text(link, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(vertical = 4.dp))
                    }
                    Text("Xovra · Free · No ads", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 14.dp))
                }
            }
        }
    }
}

private fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "Size unknown"
    val mb = bytes / 1024.0 / 1024.0
    return if (mb >= 1000) String.format(Locale.ROOT, "%.1f GB", mb / 1024) else String.format(Locale.ROOT, "%.1f MB", mb)
}

