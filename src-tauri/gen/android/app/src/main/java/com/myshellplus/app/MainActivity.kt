package com.myshellplus.app

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge (forced on Android 15+): the WebView reports no safe-area insets and the soft
    // keyboard no longer resizes it. Pad the content by the system bars and the keyboard instead,
    // so the page always fits the visible area and its bottom rows sit above the keyboard.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.rgb(10, 12, 15))
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
