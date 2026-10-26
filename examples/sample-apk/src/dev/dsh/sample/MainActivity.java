// SPDX-License-Identifier: MIT
package dev.dsh.sample;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

/**
 * One-screen sample app for the dsh-apk-vm reproducible demo.
 *
 * <p>It uses only framework classes. Tapping the button replaces the status
 * text with the exact string {@code "Hello from dsh-apk-vm"}; the demo script
 * observes that change through the plugin's UIAutomator endpoint.</p>
 */
public final class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        final TextView status = findViewById(R.id.status);
        Button hello = findViewById(R.id.hello_button);
        hello.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                status.setText(R.string.hello_message);
            }
        });
    }
}
