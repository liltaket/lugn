from esphome import automation
import esphome.codegen as cg
from esphome.components import microphone, sensor
import esphome.config_validation as cv
from esphome.const import (
    CONF_ID,
    CONF_MEASUREMENT_DURATION,
    CONF_MICROPHONE,
    DEVICE_CLASS_SOUND_PRESSURE,
    PLATFORM_ESP32,
    STATE_CLASS_MEASUREMENT,
    UNIT_DECIBEL,
)
from esphome.types import ConfigType

AUTO_LOAD = ["audio", "ring_buffer"]
DEPENDENCIES = ["microphone"]

CONF_BANDS = "bands"
CONF_CENTER = "center"
CONF_LAEQ = "laeq"
CONF_PASSIVE = "passive"
CONF_SPECTRAL_FLATNESS = "spectral_flatness"

UNIT_DECIBEL_A = "dBA"
# Nominal octave band centres; 8000 Hz is cut off at Nyquist (8 kHz at 16 kHz).
BAND_CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000]

audio_bands_ns = cg.esphome_ns.namespace("audio_bands")
AudioBandsComponent = audio_bands_ns.class_("AudioBandsComponent", cg.Component)

BAND_SCHEMA = sensor.sensor_schema(
    unit_of_measurement=UNIT_DECIBEL,
    accuracy_decimals=1,
    device_class=DEVICE_CLASS_SOUND_PRESSURE,
    state_class=STATE_CLASS_MEASUREMENT,
).extend({cv.Required(CONF_CENTER): cv.one_of(*BAND_CENTERS, int=True)})


def _unique_centers(bands: list[ConfigType]) -> list[ConfigType]:
    centers = [band[CONF_CENTER] for band in bands]
    if len(centers) != len(set(centers)):
        raise cv.Invalid("Each band center may be used only once")
    return bands


CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(AudioBandsComponent),
            cv.Optional(CONF_MEASUREMENT_DURATION, default="1000ms"): cv.All(
                cv.positive_time_period_milliseconds,
                cv.Range(
                    min=cv.TimePeriod(milliseconds=100),
                    max=cv.TimePeriod(seconds=60),
                ),
            ),
            cv.Optional(
                CONF_MICROPHONE, default={}
            ): microphone.microphone_source_schema(
                min_bits_per_sample=16,
                max_bits_per_sample=16,
                max_channels=1,
            ),
            cv.Required(CONF_PASSIVE): cv.boolean,
            cv.Optional(CONF_LAEQ): sensor.sensor_schema(
                unit_of_measurement=UNIT_DECIBEL_A,
                accuracy_decimals=1,
                device_class=DEVICE_CLASS_SOUND_PRESSURE,
                state_class=STATE_CLASS_MEASUREMENT,
            ),
            cv.Optional(CONF_BANDS): cv.All(
                cv.ensure_list(BAND_SCHEMA),
                cv.Length(min=1, max=len(BAND_CENTERS)),
                _unique_centers,
            ),
            cv.Optional(CONF_SPECTRAL_FLATNESS): sensor.sensor_schema(
                accuracy_decimals=3,
                state_class=STATE_CLASS_MEASUREMENT,
            ),
        }
    ).extend(cv.COMPONENT_SCHEMA),
    cv.has_at_least_one_key(CONF_LAEQ, CONF_BANDS, CONF_SPECTRAL_FLATNESS),
    cv.only_on([PLATFORM_ESP32]),
)

FINAL_VALIDATE_SCHEMA = cv.Schema(
    {
        cv.Required(
            CONF_MICROPHONE
        ): microphone.final_validate_microphone_source_schema("audio_bands"),
    },
    extra=cv.ALLOW_EXTRA,
)


async def to_code(config: ConfigType) -> None:
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    mic_source = await microphone.microphone_source_to_code(
        config[CONF_MICROPHONE], passive=config[CONF_PASSIVE]
    )
    cg.add(var.set_microphone_source(mic_source))
    cg.add(var.set_measurement_duration(config[CONF_MEASUREMENT_DURATION]))

    if laeq_config := config.get(CONF_LAEQ):
        cg.add(var.set_laeq_sensor(await sensor.new_sensor(laeq_config)))
    if flatness_config := config.get(CONF_SPECTRAL_FLATNESS):
        cg.add(var.set_spectral_flatness_sensor(await sensor.new_sensor(flatness_config)))
    for band in config.get(CONF_BANDS, []):
        cg.add(var.add_band(band[CONF_CENTER], await sensor.new_sensor(band)))


AUDIO_BANDS_ACTION_SCHEMA = automation.maybe_simple_id(
    {
        cv.GenerateID(): cv.use_id(AudioBandsComponent),
    }
)

automation.register_apply_action(
    "audio_bands.start", AUDIO_BANDS_ACTION_SCHEMA, automation.ApplyCall("start()")
)
automation.register_apply_action(
    "audio_bands.stop", AUDIO_BANDS_ACTION_SCHEMA, automation.ApplyCall("stop()")
)
