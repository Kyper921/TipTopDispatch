
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface TimePickerProps {
  value: string; // "HH:mm"
  onChange: (value: string) => void;
}

const hours = Array.from({ length: 12 }, (_, i) => i + 1);
const minutes = Array.from({ length: 12 }, (_, i) => i * 5); // 5-minute increments
const periods = ['AM', 'PM'];

const TimePicker: React.FC<TimePickerProps> = ({ value, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Parse 24-hour time string into 12-hour parts
  const parseTime = (time24: string) => {
    const [h, m] = time24.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12; // Convert 0 or 12 to 12
    return { hour: hour12, minute: m, period };
  };

  const { hour: currentHour, minute: currentMinute, period: currentPeriod } = parseTime(value);

  // Handle outside click and scroll to close popover
  useEffect(() => {
    if (!isOpen) return;

    const handleInteraction = (event: Event) => {
       // Check if click is inside the button or the portal content (handled by event bubbling usually, but portal is separate DOM tree)
       // For scroll/resize we just close it for safety
       if (event.type === 'scroll' || event.type === 'resize') {
           setIsOpen(false);
           return;
       }
       
       if (event.type === 'mousedown') {
           const target = event.target as Node;
           // If clicking the button itself, let the button click handler toggle it
           if (buttonRef.current && buttonRef.current.contains(target)) {
               return;
           }
           // Check if clicking inside the portal (we add an ID or ref to portal wrapper)
           const portal = document.getElementById('time-picker-portal');
           if (portal && portal.contains(target)) {
               return;
           }
           setIsOpen(false);
       }
    };

    document.addEventListener('mousedown', handleInteraction);
    window.addEventListener('scroll', handleInteraction, true); // Capture phase for all scrollable elements
    window.addEventListener('resize', handleInteraction);

    return () => {
        document.removeEventListener('mousedown', handleInteraction);
        window.removeEventListener('scroll', handleInteraction, true);
        window.removeEventListener('resize', handleInteraction);
    };
  }, [isOpen]);

  const toggleOpen = () => {
      if (isOpen) {
          setIsOpen(false);
      } else if (buttonRef.current) {
          const rect = buttonRef.current.getBoundingClientRect();
          const viewportHeight = window.innerHeight;
          const spaceBelow = viewportHeight - rect.bottom;
          const spaceAbove = rect.top;
          const dropdownHeight = 340; // Estimated height with header

          // Smart positioning: prefer below, unless not enough space and more space above
          let pos: { top?: number; bottom?: number; left: number; width: number };
          
          if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
              // Show above
              pos = {
                  bottom: viewportHeight - rect.top + 4, // 4px gap
                  left: rect.left,
                  width: rect.width
              };
          } else {
              // Show below
              pos = {
                  top: rect.bottom + 4,
                  left: rect.left,
                  width: rect.width
              };
          }
          setPosition(pos);
          setIsOpen(true);
      }
  };

  const handleTimeChange = (newPart: { hour?: number, minute?: number, period?: string }) => {
    let { hour, minute, period } = { ...parseTime(value), ...newPart };
    
    // Convert 12-hour format back to 24-hour
    let h24 = hour;
    if (period === 'PM' && hour < 12) {
      h24 = hour + 12;
    } else if (period === 'AM' && hour === 12) { // Midnight case
      h24 = 0;
    }
    
    const formatted24Hour = `${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    onChange(formatted24Hour);
  };
  
  const displayTime = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')} ${currentPeriod}`;
  
  return (
    <>
        <button
            ref={buttonRef}
            type="button"
            onClick={toggleOpen}
            className="w-full bg-gray-800 border border-gray-600 rounded-md px-3 py-2 text-white text-sm text-left font-mono focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 truncate"
        >
            {displayTime}
        </button>

        {isOpen && position && createPortal(
            <div 
                id="time-picker-portal"
                className="fixed bg-gray-800 border border-gray-700 rounded-md shadow-2xl z-[9999] p-2 flex flex-col"
                style={{
                    top: position.top,
                    bottom: position.bottom,
                    left: position.left,
                    width: Math.max(position.width, 180) // Ensure min width
                }}
            >
            {/* AM/PM Toggle Header */}
            <div className="flex bg-gray-900/50 rounded p-1 mb-2 shrink-0 border border-gray-700">
                {periods.map(p => (
                    <button
                        key={`p-${p}`}
                        onClick={() => handleTimeChange({ period: p })}
                        className={`flex-1 text-center py-1 text-xs font-bold rounded transition-colors ${
                        currentPeriod === p
                            ? 'bg-cyan-600 text-white shadow-sm'
                            : 'text-gray-400 hover:text-white hover:bg-gray-700'
                        }`}
                    >
                        {p}
                    </button>
                ))}
            </div>

            <div className="flex flex-row space-x-1">
                {/* Hours Column */}
                <div className="flex-1">
                    <p className="text-[10px] font-bold text-center text-gray-500 mb-1 tracking-wider">HR</p>
                    <div className="flex flex-col space-y-0.5">
                        {hours.map(h => (
                        <button
                            key={`h-${h}`}
                            onClick={() => handleTimeChange({ hour: h })}
                            className={`w-full text-center px-1 py-0.5 text-sm rounded transition-colors ${
                            currentHour === h
                                ? 'bg-cyan-600 text-white font-semibold'
                                : 'text-gray-300 hover:bg-gray-700'
                            }`}
                        >
                            {String(h).padStart(2, '0')}
                        </button>
                        ))}
                    </div>
                </div>
                
                {/* Minutes Column */}
                <div className="flex-1 border-l border-gray-700 pl-1">
                    <p className="text-[10px] font-bold text-center text-gray-500 mb-1 tracking-wider">MIN</p>
                    <div className="flex flex-col space-y-0.5">
                        {minutes.map(m => (
                        <button
                            key={`m-${m}`}
                            onClick={() => handleTimeChange({ minute: m })}
                            className={`w-full text-center px-1 py-0.5 text-sm rounded transition-colors ${
                            currentMinute === m
                                ? 'bg-cyan-600 text-white font-semibold'
                                : 'text-gray-300 hover:bg-gray-700'
                            }`}
                        >
                            {String(m).padStart(2, '0')}
                        </button>
                        ))}
                    </div>
                </div>
            </div>
            </div>,
            document.body
        )}
    </>
  );
};

export default TimePicker;
