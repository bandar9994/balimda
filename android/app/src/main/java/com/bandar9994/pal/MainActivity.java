package com.bandar9994.pal;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PalLlamaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
